#!/usr/bin/env bun
// The denoisers' weights, each in a tree of its own in the user's cache, which
// `native/rawshim/.pmrid/` and `.upscaler/` then point at (`pinned.ts` says why they are not in
// the checkout). `src/pmrid.rs` and `src/upscale.rs` embed them, so the crate does not build
// without them.
//
// PMRID's published checkpoint is unpacked into a flat f32 blob and a plan the shader can walk. It
// is a PyTorch zip - `archive/data.pkl` naming storages under `archive/data/`, each a raw
// little-endian f32 array. We have no Python, so the pickle is not interpreted: the tensors appear
// in it as a name followed by its storage's id, in the order `state_dict` returns them, and that
// order is the network's own. Every tensor's shape is known from the architecture
// (`models/net_torch.py`), so a scan for those two strings, paired in order and checked against
// the shape's element count, recovers the whole of it.
//
// The upscaler's are `models/upscaler`'s `export`, published as `upscaler.json` and `upscaler.bin`
// beside the project's other models. `--from <dir>` takes them from a folder as `export` names them
// instead, held to the same hashes: a training run's own `runs/<name>/`.

import { type Unzipped, unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alreadyPinned, fetchPinned, linkPinned, makeOnce, pin, pinnedHome } from './pinned';

const CHECKPOINT =
  'https://raw.githubusercontent.com/MegEngine/PMRID/8ebb9e8e96559881dee957f34243933c5beb77dd/models/torch_pretrained.ckp';
const CHECKPOINT_SHA256 = '9361614f3514d27351d81909f2215c0fdc38619c0288d936b7266485ac106c14';
// This file's own text too: the unpacking below decides the bytes as much as the checkpoint does.
const PMRID_RECIPE = pin(CHECKPOINT, [
  CHECKPOINT_SHA256,
  readFileSync(import.meta.path, 'utf8').replaceAll('\r\n', '\n'),
]);
const PMRID_HOME = pinnedHome('pmrid', PMRID_RECIPE);

const REPOSITORY = 'https://huggingface.co/bitnimble/bowerbird/resolve/main';
/** Each file of the tree, by the name the repository holds it under and its hash. */
const UPSCALER_FILES = {
  'weights.json': {
    remote: 'upscaler.json',
    sha256: '300e1488b2b90219f9eeb9d5d937f198f96df5ec8b20315b1e60967b80f757a9',
  },
  'weights.bin': {
    remote: 'upscaler.bin',
    sha256: '85fe4e140ad548293a160b401c213ea3c8f058757661b0ca09701e9ebd60877a',
  },
} as const;
const UPSCALER_RECIPE = pin(
  REPOSITORY,
  Object.values(UPSCALER_FILES).flatMap(({ remote, sha256 }) => [remote, sha256]),
);
const UPSCALER_HOME = pinnedHome('upscaler', UPSCALER_RECIPE);

const PICKLE = 'archive/data.pkl';
const STORAGES = 'archive/data/';

type Shape = number[];
type Tensor = { name: string; shape: Shape };

/// A convolution as `net_torch.py` builds one, separable or not.
function conv(prefix: string, inC: number, outC: number, k: number, separable: boolean): Tensor[] {
  if (!separable) {
    return [
      { name: `${prefix}.conv.weight`, shape: [outC, inC, k, k] },
      { name: `${prefix}.conv.bias`, shape: [outC] },
    ];
  }
  return [
    { name: `${prefix}.depthwise.weight`, shape: [inC, 1, k, k] },
    { name: `${prefix}.pointwise.weight`, shape: [outC, inC, 1, 1] },
    { name: `${prefix}.pointwise.bias`, shape: [outC] },
  ];
}

function encoderBlock(
  prefix: string,
  inC: number,
  midC: number,
  outC: number,
  stride: number,
): Tensor[] {
  const tensors = [
    ...conv(`${prefix}.conv1`, inC, midC, 5, true),
    ...conv(`${prefix}.conv2`, midC, outC, 5, true),
  ];
  if (!(stride === 1 && inC === outC)) tensors.push(...conv(`${prefix}.proj`, inC, outC, 3, true));
  return tensors;
}

function encoderStage(prefix: string, inC: number, outC: number, blocks: number): Tensor[] {
  const tensors = encoderBlock(`${prefix}.0`, inC, outC / 4, outC, 2);
  for (let i = 1; i < blocks; i++) {
    tensors.push(...encoderBlock(`${prefix}.${i}`, outC, outC / 4, outC, 1));
  }
  return tensors;
}

function decoderBlock(prefix: string, inC: number, outC: number, k: number): Tensor[] {
  return [
    ...conv(`${prefix}.conv0`, inC, outC, k, true),
    ...conv(`${prefix}.conv1`, outC, outC, k, true),
  ];
}

function decoderStage(prefix: string, inC: number, skipC: number, outC: number): Tensor[] {
  return [
    ...decoderBlock(`${prefix}.decode_conv`, inC, inC, 3),
    { name: `${prefix}.upsample.weight`, shape: [inC, outC, 2, 2] },
    { name: `${prefix}.upsample.bias`, shape: [outC] },
    ...conv(`${prefix}.proj_conv`, skipC, outC, 3, true),
  ];
}

const ARCHITECTURE: Tensor[] = [
  ...conv('conv0', 4, 16, 3, false),
  ...encoderStage('enc1', 16, 64, 2),
  ...encoderStage('enc2', 64, 128, 2),
  ...encoderStage('enc3', 128, 256, 4),
  ...encoderStage('enc4', 256, 512, 4),
  ...conv('encdec', 512, 64, 3, true),
  ...decoderStage('dec1', 64, 256, 64),
  ...decoderStage('dec2', 64, 128, 32),
  ...decoderStage('dec3', 32, 64, 32),
  ...decoderStage('dec4', 32, 16, 16),
  ...decoderBlock('out0', 16, 16, 3),
  ...conv('out1', 16, 4, 3, false),
];

/// Every name-then-storage-id pair in `data.pkl`, in the order the file states them.
function pairs(pickle: Uint8Array): { name: string; storage: string }[] {
  // Byte-for-byte, so an offset in the text is an offset in the pickle and a stray high byte
  // cannot end a run early: a UTF-8 decode would replace those and can merge or split a name.
  const text = Buffer.from(pickle).toString('latin1');
  const found: { name: string; storage: string }[] = [];
  // A key is a dotted path ending in `weight` or `bias`; a storage id is the run of digits that
  // follows it, which is the file under `archive/data/`.
  const token = /[A-Za-z][A-Za-z0-9_.]*\.(?:weight|bias)|[0-9]{4,}/g;
  let pending: string | null = null;
  for (const match of text.matchAll(token)) {
    const value = match[0];
    if (/^[0-9]+$/.test(value)) {
      if (pending) found.push({ name: pending, storage: value });
      pending = null;
    } else {
      pending = value;
    }
  }
  return found;
}

const numel = (shape: Shape) => shape.reduce((a, b) => a * b, 1);

function entry(entries: Unzipped, name: string): Uint8Array {
  const bytes = entries[name];
  if (bytes == null) {
    throw new Error(`the checkpoint holds no ${name}`);
  }
  // A copy, so a `Float32Array` can be laid over it whatever offset the archive kept it at.
  return new Uint8Array(bytes);
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--from');
  const from = at === -1 ? null : process.argv[at + 1];
  if (at !== -1 && from == null)
    throw new Error("--from needs a folder holding the upscaler's weights.json and weights.bin");
  await getPmrid();
  await getUpscaler(from ?? null);
}

async function getPmrid(): Promise<void> {
  if (!alreadyPinned(PMRID_HOME, PMRID_RECIPE)) {
    const response = await fetchPinned(CHECKPOINT);
    const checkpoint = new Uint8Array(await response.arrayBuffer());
    const got = createHash('sha256').update(checkpoint).digest('hex');
    if (got !== CHECKPOINT_SHA256)
      throw new Error(`${CHECKPOINT} hashes ${got}, not the pinned ${CHECKPOINT_SHA256}`);
    const unpacked = unpack(checkpoint);
    makeOnce(PMRID_HOME, PMRID_RECIPE, false, () => {
      for (const [name, bytes] of unpacked) writeFileSync(resolve(PMRID_HOME, name), bytes);
    });
  }
  linkPinned('pmrid', PMRID_HOME);
  console.log(`pmrid at ${PMRID_HOME}`);
}

type UpscalerFile = keyof typeof UPSCALER_FILES;

async function getUpscaler(from: string | null): Promise<void> {
  if (!alreadyPinned(UPSCALER_HOME, UPSCALER_RECIPE)) {
    const fetched = new Map<UpscalerFile, Uint8Array>();
    for (const name of Object.keys(UPSCALER_FILES) as UpscalerFile[]) {
      const { remote, sha256 } = UPSCALER_FILES[name];
      const source = from == null ? `${REPOSITORY}/${remote}` : resolve(from, name);
      const bytes =
        from == null
          ? new Uint8Array(await (await fetchPinned(source)).arrayBuffer())
          : new Uint8Array(readFileSync(source));
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== sha256) throw new Error(`${source} hashes ${got}, not the pinned ${sha256}`);
      fetched.set(name, bytes);
    }
    makeOnce(UPSCALER_HOME, UPSCALER_RECIPE, false, () => {
      for (const [name, bytes] of fetched) writeFileSync(resolve(UPSCALER_HOME, name), bytes);
    });
  }
  linkPinned('upscaler', UPSCALER_HOME);
  console.log(`upscaler at ${UPSCALER_HOME}`);
}

function unpack(checkpoint: Uint8Array): Map<string, Uint8Array | string> {
  // A checkpoint is a zip, and Windows ships no `unzip` for the other getters' `tar` to be.
  const entries = unzipSync(checkpoint, {
    filter: ({ name }) => name === PICKLE || name.startsWith(STORAGES),
  });
  const named = pairs(entry(entries, PICKLE));
  if (named.length !== ARCHITECTURE.length) {
    throw new Error(
      `the checkpoint names ${named.length} tensors, the architecture ${ARCHITECTURE.length}`,
    );
  }

  const blob = new Float32Array(ARCHITECTURE.reduce((sum, t) => sum + numel(t.shape), 0));
  const offsets: Record<string, number> = {};
  let at = 0;
  for (const [index, tensor] of ARCHITECTURE.entries()) {
    const { name, storage } = named[index]!;
    if (name !== tensor.name)
      throw new Error(`tensor ${index} is ${name}, the architecture says ${tensor.name}`);
    const raw = entry(entries, `${STORAGES}${storage}`);
    const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    if (values.length !== numel(tensor.shape)) {
      throw new Error(
        `${name} holds ${values.length} floats, ${tensor.shape} wants ${numel(tensor.shape)}`,
      );
    }
    blob.set(values, at);
    offsets[name] = at;
    at += values.length;
  }

  const plan = {
    source: CHECKPOINT,
    floats: blob.length,
    tensors: ARCHITECTURE.map((t) => ({ name: t.name, shape: t.shape, offset: offsets[t.name] })),
  };
  console.log(`weights.bin: ${ARCHITECTURE.length} tensors, ${blob.length} floats`);
  return new Map<string, Uint8Array | string>([
    ['weights.bin', new Uint8Array(blob.buffer)],
    ['weights.json', `${JSON.stringify(plan, null, 2)}\n`],
  ]);
}

if (import.meta.main) {
  await main();
}

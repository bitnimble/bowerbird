#!/usr/bin/env bun
// PMRID's published weights, unpacked into a flat f32 blob and a plan the shader can walk.
//
// A prototype, to see what a learned denoiser does to our photographs before anything is built
// around one. Nothing in the pipeline reads this: `native/rawshim/examples/pmrid.rs` does, and
// only when it is there.
//
// The checkpoint is a PyTorch zip - `archive/data.pkl` naming storages under `archive/data/`,
// each a raw little-endian f32 array. We have no Python, so the pickle is not interpreted: the
// tensors appear in it as a name followed by its storage's id, in the order `state_dict` returns
// them, and that order is the network's own. Every tensor's shape is known from the architecture
// (`models/net_torch.py`), so a scan for those two strings, paired in order and checked against
// the shape's element count, recovers the whole of it.

import { mkdir, rm } from 'node:fs/promises';

const CHECKPOINT = 'https://raw.githubusercontent.com/MegEngine/PMRID/main/models/torch_pretrained.ckp';
const OUT = 'native/rawshim/.pmrid';

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

function encoderBlock(prefix: string, inC: number, midC: number, outC: number, stride: number): Tensor[] {
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
  return [...conv(`${prefix}.conv0`, inC, outC, k, true), ...conv(`${prefix}.conv1`, outC, outC, k, true)];
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

async function main() {
  const response = await fetch(CHECKPOINT);
  if (!response.ok) throw new Error(`${CHECKPOINT}: ${response.status}`);
  const checkpoint = new Uint8Array(await response.arrayBuffer());

  const scratch = `${OUT}/checkpoint`;
  await rm(OUT, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const zip = `${scratch}/torch_pretrained.ckp`;
  await Bun.write(zip, checkpoint);
  const unzip = Bun.spawnSync(['unzip', '-q', '-o', zip, '-d', scratch]);
  if (unzip.exitCode !== 0) throw new Error(`unzip: ${unzip.stderr.toString()}`);

  const pickle = new Uint8Array(await Bun.file(`${scratch}/archive/data.pkl`).arrayBuffer());
  const named = pairs(pickle);
  if (named.length !== ARCHITECTURE.length) {
    throw new Error(`the checkpoint names ${named.length} tensors, the architecture ${ARCHITECTURE.length}`);
  }

  const blob = new Float32Array(ARCHITECTURE.reduce((sum, t) => sum + numel(t.shape), 0));
  const offsets: Record<string, number> = {};
  let at = 0;
  for (const [index, tensor] of ARCHITECTURE.entries()) {
    const { name, storage } = named[index]!;
    if (name !== tensor.name) throw new Error(`tensor ${index} is ${name}, the architecture says ${tensor.name}`);
    const raw = new Uint8Array(await Bun.file(`${scratch}/archive/data/${storage}`).arrayBuffer());
    const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    if (values.length !== numel(tensor.shape)) {
      throw new Error(`${name} holds ${values.length} floats, ${tensor.shape} wants ${numel(tensor.shape)}`);
    }
    blob.set(values, at);
    offsets[name] = at;
    at += values.length;
  }

  await Bun.write(`${OUT}/weights.bin`, new Uint8Array(blob.buffer));
  await Bun.write(
    `${OUT}/weights.json`,
    `${JSON.stringify(
      {
        source: CHECKPOINT,
        floats: blob.length,
        tensors: ARCHITECTURE.map((t) => ({ name: t.name, shape: t.shape, offset: offsets[t.name] })),
      },
      null,
      2,
    )}\n`,
  );
  await rm(scratch, { recursive: true, force: true });
  console.log(`${OUT}/weights.bin: ${ARCHITECTURE.length} tensors, ${blob.length} floats`);
}

await main();

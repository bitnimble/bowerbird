#!/usr/bin/env bun
// The 2x upscaler's weights (`models/upscaler`), as `export` wrote them, in the user's cache, which
// `native/rawshim/.upscaler/` then points at (`pinned.ts` says why it is not in the checkout).
// `src/upscale.rs` embeds them, so the crate does not build without them.
//
// `--from <dir>` takes the two files from a folder instead of the repository, held to the same
// hashes: a training run's own `runs/<name>/`.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alreadyPinned, fetchPinned, linkPinned, makeOnce, pin, pinnedHome } from './pinned';

const NAME = 'upscaler';
const REPOSITORY = 'https://huggingface.co/bowerbird/upscaler/resolve/main';
const FILES = {
  'weights.json': '300e1488b2b90219f9eeb9d5d937f198f96df5ec8b20315b1e60967b80f757a9',
  'weights.bin': '85fe4e140ad548293a160b401c213ea3c8f058757661b0ca09701e9ebd60877a',
} as const;
const RECIPE = pin(REPOSITORY, Object.values(FILES));
const HOME = pinnedHome(NAME, RECIPE);

type File = keyof typeof FILES;

async function main(): Promise<void> {
  const at = process.argv.indexOf('--from');
  const from = at === -1 ? null : process.argv[at + 1];
  if (at !== -1 && from == null)
    throw new Error('--from needs a folder holding weights.json and weights.bin');
  if (!alreadyPinned(HOME, RECIPE)) {
    const fetched = new Map<File, Uint8Array>();
    for (const name of Object.keys(FILES) as File[]) {
      const bytes =
        from == null
          ? new Uint8Array(await (await fetchPinned(`${REPOSITORY}/${name}`)).arrayBuffer())
          : new Uint8Array(readFileSync(resolve(from, name)));
      const got = createHash('sha256').update(bytes).digest('hex');
      if (got !== FILES[name])
        throw new Error(
          `${name} from ${from ?? REPOSITORY} hashes ${got}, not the pinned ${FILES[name]}`,
        );
      fetched.set(name, bytes);
    }
    makeOnce(HOME, RECIPE, false, () => {
      for (const [name, bytes] of fetched) writeFileSync(resolve(HOME, name), bytes);
    });
  }
  linkPinned(NAME, HOME);
  console.log(`upscaler at ${HOME}`);
}

if (import.meta.main) {
  await main();
}

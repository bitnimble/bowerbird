// Downloads the pinned HDR environments the print preview hangs a sheet in, into the user's cache,
// which `native/rawshim/.environments/` then points at (`pinned.ts` says why it is not in the
// checkout).
//
//   bun run get:environments
//
// Poly Haven's, all CC0: `print_environment.rs` names which light in each the lamp stands
// for. `hash-pkg.ts` serves them beside the wasm module for the editor to fetch, and the native
// tests read them from here.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alreadyPinned, linkPinned, makeOnce, pin, pinnedHome } from './pinned';

const NAME = 'environments';
const SOURCE = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr';

export const ENVIRONMENTS: Record<string, { file: string; sha256: string }> = {
  studio: { file: '2k/poly_haven_studio_2k.hdr', sha256: '65ffbd4ffdce0914d61e5c28e078a14491a973cdbebbd82fc3c47b30153955b5' },
  meadow: { file: '2k/meadow_2_2k.hdr', sha256: '18155b1114a567d3abcae29a89a4e8c12cb56fcda1edbb107fa79137f9a673f2' },
  hotel: { file: '2k/hotel_room_2k.hdr', sha256: '14fdf682ee084d8ad68c77b47031e473fd89413c8b99cb988366c6ac1afb3918' },
};
const RECIPE = pin(SOURCE, Object.values(ENVIRONMENTS).map(({ sha256 }) => sha256));
const HOME = pinnedHome(NAME, RECIPE);

async function download(file: string, sha256: string): Promise<Buffer> {
  const url = `${SOURCE}/${file}`;
  const answer = await fetch(url);
  if (!answer.ok) {
    throw new Error(`${url} answered ${answer.status} ${answer.statusText}`);
  }
  const bytes = Buffer.from(await answer.arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) {
    throw new Error(`${file} hashes ${got}, not the pinned ${sha256}`);
  }
  return bytes;
}

async function main(): Promise<void> {
  if (!alreadyPinned(HOME, RECIPE)) {
    const fetched = new Map<string, Buffer>();
    for (const [name, { file, sha256 }] of Object.entries(ENVIRONMENTS)) {
      fetched.set(`${name}.hdr`, await download(file, sha256));
    }
    makeOnce(HOME, RECIPE, false, () => {
      for (const [name, bytes] of fetched) {
        writeFileSync(resolve(HOME, name), bytes);
      }
    });
  }
  linkPinned(NAME, HOME);
  console.log(`environments at ${HOME}`);
}

if (import.meta.main) {
  await main();
}

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The synthetic views a panorama is composed out of, written where a library can index them.
//
// **By the crate rather than here.** The scene and the rig are `composite_scene`'s, and
// `composite_align`'s own suite aligns the same six views - so a panorama on screen and a panorama
// under test are looking at the same world, and there is no second implementation of the
// projection to drift from the one it is a fixture for.
//
// Rendered rather than committed: half a megabyte of noise field each, in a repository whose
// binary fixtures are RAWs nobody can generate. Once per checkout, since they are a pure function
// of the crate - `test/fixtures/pano-views` is where the suites keep theirs, and it is gitignored
// like every other PNG.

// `import.meta.url` rather than Bun's `import.meta.dir`: Playwright loads its config - and so
// this - through Node, where `dir` is undefined and every path built from it resolves to nothing.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What `composite_scene::rig` writes, in the order it writes them. */
export const PANORAMA_VIEW_NAMES = ['view0.png', 'view1.png', 'view2.png', 'view3.png', 'view4.png', 'view5.png'];

/**
 * Writes the views into `directory`, unless they are all already there.
 *
 * Skipped when they are, because this is called from a fixture setup that runs per test run and
 * the views are a pure function of the crate: six 1280x800 renders of a noise field, and nothing
 * about them changes between runs.
 */
export function panoramaViews(directory: string): string[] {
  const paths = PANORAMA_VIEW_NAMES.map((name) => path.join(directory, name));
  if (paths.every((at) => existsSync(at))) return paths;

  const run = spawnSync(
    'bun',
    [
      'run',
      path.join(ROOT, 'scripts/cargo.ts'),
      'run',
      '--profile',
      'quick',
      '--manifest-path',
      path.join(ROOT, 'native/rawshim/Cargo.toml'),
      '--example',
      'composite_views',
      '--',
      directory,
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (run.status !== 0) {
    throw new Error(`could not write the panorama views into ${directory}`);
  }
  return paths;
}

// Run directly rather than imported. `import.meta.main` is Bun's and undefined under Node, which
// is the loader Playwright's config arrives through - so the comparison decides it instead.
if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (directory == null) {
    process.stderr.write('pano-views <dir>\n');
    process.exit(2);
  }
  for (const at of panoramaViews(directory)) process.stdout.write(`${at}\n`);
}

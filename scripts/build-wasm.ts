// The browser's package, `native/rawshim/pkg`: rawshim as wasm, the AV1 decoder beside it, and
// the files `hash-pkg.ts` serves with them.
//
// Skipped when the package on disk was built from exactly these inputs, whoever built it: CI's
// `wasm` job builds it once and every app job downloads it with no `target/` to be fresh against.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const PKG = join(ROOT, 'native', 'rawshim', 'pkg');
const STAMP = join(PKG, 'built-from.sha256');
const INPUTS = [
  'native',
  'slang',
  'scripts/build-wasm.ts',
  'scripts/hash-pkg.ts',
  'scripts/build-avif-planes.ts',
  'scripts/cargo.ts',
  'scripts/pinned.ts',
  'scripts/vcpkg.ts',
  'scripts/get-slangc.ts',
  'scripts/get-pmrid.ts',
  'scripts/get-environments.ts',
];

function git(cwd: string, args: string[], input?: string): string | null {
  const done = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return done.status === 0 ? done.stdout : null;
}

/**
 * `path blob` for every file under `paths` in the repository at `repo` (relative to the root, with
 * `/`), as Git would store it: mtimes and line endings do not count.
 */
function blobs(repo: string, paths: string[]): string[] | null {
  const at = join(ROOT, repo);
  const listed = git(at, ['ls-files', '-z', '-co', '--exclude-standard', '--', ...paths]);
  if (listed == null) return null;
  // A submodule is listed as its directory, and a deleted file is still in the index.
  const files = listed
    .split('\0')
    .filter((path) => statSync(join(at, path), { throwIfNoEntry: false })?.isFile());
  if (files.length === 0) return [];
  const hashed = git(at, ['hash-object', '--stdin-paths'], `${files.join('\n')}\n`);
  if (hashed == null) return null;
  const ids = hashed.trim().split('\n');
  return files.map((path, index) => `${repo}/${path} ${ids[index]}`);
}

/** Null outside a Git checkout, the Docker stages', which then always build. */
function inputsHash(): string | null {
  const submodules = (git(ROOT, ['config', '-f', '.gitmodules', '--get-regexp', 'path']) ?? '')
    .split('\n')
    .map((line) => line.split(' ')[1])
    .filter((path): path is string => path != null && path.startsWith('native/'));
  const lines = blobs('.', INPUTS);
  if (lines == null) return null;
  for (const submodule of submodules) {
    const inside = blobs(submodule, ['.']);
    if (inside == null) return null;
    lines.push(...inside);
  }
  const rustc = spawnSync('rustc', ['-V'], { encoding: 'utf8' }).stdout ?? '';
  return createHash('sha256').update(rustc).update(lines.sort().join('\n')).digest('hex');
}

function run(command: string, args: string[]): void {
  const done = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

const inputs = inputsHash();
const built = existsSync(STAMP) ? readFileSync(STAMP, 'utf8').trim() : null;
if (inputs != null && built === inputs) {
  console.log(`pkg: already built from these sources (${inputs.slice(0, 12)})`);
  process.exit(0);
}

rmSync(STAMP, { force: true });
rmSync(join(PKG, 'package.json'), { force: true });
run('bun', [
  'x',
  'wasm-pack@0.13.1',
  'build',
  'native/rawshim',
  '--target',
  'web',
  '--out-dir',
  'pkg',
  '--no-opt',
  '--',
  '--no-default-features',
]);
run('bun', ['run', 'scripts/hash-pkg.ts']);
run('bun', ['run', 'scripts/build-avif-planes.ts']);
if (inputs != null) writeFileSync(STAMP, `${inputs}\n`);

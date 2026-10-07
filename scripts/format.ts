import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const VENDORED = join(ROOT, 'native', 'vendor') + sep;
const args = process.argv.slice(2);
const check = args.includes('--check');
const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--check');
if (unknown.length > 0) fail(`Unknown option ${unknown.join(', ')}. Only --check is accepted.`);
const paths = args.filter((arg) => arg !== '--check').map((path) => resolve(path));

if (paths.length === 0) {
  const suffix = check ? ':check' : '';
  run(process.execPath, ['run', `format:prettier${suffix}`]);
  run(process.execPath, ['run', `format:rust${suffix}`]);
  process.exit(0);
}

for (const path of paths) {
  if (!existsSync(path)) fail(`${path} does not exist.`);
  if (statSync(path).isDirectory()) fail(`${path} is a directory. Name the files to format.`);
}
const rust = paths
  .filter((path) => path.endsWith('.rs'))
  .map((path) => ({ path, edition: editionOf(path) }));
const other = paths.filter((path) => !path.endsWith('.rs'));

if (other.length > 0) {
  run(process.execPath, [
    'x',
    '--no-install',
    'prettier',
    check ? '--check' : '--write',
    '--ignore-unknown',
    ...other,
  ]);
}
const unformatted = rust.filter(({ path, edition }) => !formatRust(path, edition));
if (unformatted.length > 0) {
  for (const { path } of unformatted) console.error(`${relative(ROOT, path)} is not formatted.`);
  process.exit(1);
}

/** Whether `path` was already formatted; rewritten in place unless checking. */
function formatRust(path: string, edition: string): boolean {
  const source = readFileSync(path, 'utf8');
  // Through stdin: given a path, rustfmt also formats every `mod` the file declares.
  const result = spawnSync(
    'rustfmt',
    ['--edition', edition, '--config-path', join(ROOT, 'rustfmt.toml'), '--emit', 'stdout'],
    { cwd: ROOT, input: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] },
  );
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (result.stdout === source) return true;
  if (check) return false;
  writeFileSync(path, result.stdout);
  return true;
}

function editionOf(file: string): string {
  if (file.startsWith(VENDORED)) {
    fail(`${relative(ROOT, file)} is vendored. Format only the owned crates.`);
  }
  for (let dir = dirname(file); dir === ROOT || dir.startsWith(ROOT + sep); dir = dirname(dir)) {
    const manifest = join(dir, 'Cargo.toml');
    if (!existsSync(manifest)) continue;
    const edition = /^edition\s*=\s*"(\d+)"/m.exec(readFileSync(manifest, 'utf8'))?.[1];
    if (edition != null) return edition;
  }
  return fail(`No Cargo.toml in this repository declares an edition for ${file}.`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function run(command: string, commandArgs: string[]): void {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit' });
  if (result.error != null) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Builds the Tauri CLI this application is actually built by, into the user's cache.
//
//   bun run get:tauri
//
// **Not `@tauri-apps/cli` from npm, and the difference is the whole Linux build.** The crates come
// from a git revision rather than crates.io, because that revision is where CEF is a runtime
// (`src-tauri/Cargo.toml` says why the shell wants one). npm publishes the stock CLI, which has
// never heard of CEF: it knows `linuxdeploy` and nothing about `sharun` or `libcef.so`, so it
// assembles an AppImage that fails on a library it cannot find and a deb that installs an
// application with no runtime beside it - and no flag makes it do otherwise, the code not being in
// it. The revision is read out of the manifest rather than written twice, so bumping the crates
// moves the CLI with them.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeOnce, pin, pinnedHome } from './pinned';

const NAME = 'tauri-cli';
const REPOSITORY = 'https://github.com/tauri-apps/tauri';
const ROOT = resolve(import.meta.dir, '..');

/** The revision `src-tauri` takes `tauri` from, which is the one thing this has to agree with. */
function revision(): string {
  const manifest = readFileSync(resolve(ROOT, 'src-tauri/Cargo.toml'), 'utf8');
  const revisions = new Set([...manifest.matchAll(/rev = "([0-9a-f]{40})"/g)].map((it) => it[1]!));
  if (revisions.size !== 1) {
    throw new Error(`src-tauri/Cargo.toml names ${revisions.size} tauri revisions, wanted one`);
  }
  return [...revisions][0]!;
}

const REV = revision();
const RECIPE = pin(REV, [REPOSITORY]);
const HOME = pinnedHome(NAME, RECIPE);

function main(): void {
  // No symlink beside the crate as the other trees get: nothing here is a build input, and the
  // scripts that drive it ask by calling `cli()`.
  makeOnce(HOME, RECIPE, process.env.BOWERBIRD_REBUILD_TAURI_CLI != null, build);
  console.log(`tauri-cli ${REV.slice(0, 8)} at ${binary()}`);
}

function build(): void {
  // `--locked` so the CLI is built against the lockfile its own revision was tested with, rather
  // than whatever resolves today - the same reason every other tree here is pinned.
  const args = ['install', '--git', REPOSITORY, '--rev', REV, '--locked', '--root', HOME, 'tauri-cli'];
  const done = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`cargo ${args.join(' ')} exited ${done.status}`);
  }
}

/** Where `cargo install` puts it, which is the name cargo subcommands take. */
function binary(): string {
  return resolve(HOME, 'bin', process.platform === 'win32' ? 'cargo-tauri.exe' : 'cargo-tauri');
}

/** The pinned CLI, for a script about to drive it, or a refusal naming the command that builds it. */
export function cli(): string {
  const at = binary();
  if (!existsSync(at)) {
    throw new Error(`${at}: no Tauri CLI here. \`bun run get:tauri\` builds the pinned one.`);
  }
  return at;
}

if (import.meta.main) main();

// Fetches the pinned Slang compiler into the user's cache, which `native/rawshim/.slangc/` then
// points at (`pinned.ts` says why it is not in the checkout).
//
//   bun run get:slangc
//
// `build.rs` looks here first and then on `PATH`, and refuses with this command's name when it
// finds neither. Nothing fetches during a build: a compiler that arrives over the network mid-build
// is a build whose output depends on the day it ran.
//
// **The version is pinned because codegen moves.** Two Slang releases can lower the same source to
// arithmetic that differs in the last bit, and the snapshots are compared with a tolerance a codegen
// change can cross. Bumping this is a deliberate act with the fixtures re-read,
// not a `latest` that shifts under whoever built most recently.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { linkPinned, makeOnce, pin, pinnedHome } from './pinned';

const NAME = 'slangc';
const VERSION = '2026.14.1';
const ROOT = resolve(import.meta.dir, '..');

/** The release asset for this machine, as Slang names them. */
function asset(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const named: Partial<Record<NodeJS.Platform, string>> = {
    linux: 'linux',
    darwin: 'macos',
    win32: 'windows',
  };
  const platform = named[process.platform];
  if (platform == null) {
    throw new Error(`no Slang release for ${process.platform}`);
  }
  return `slang-${VERSION}-${platform}-${arch}.tar.gz`;
}

function run(command: string, args: string[]): void {
  const done = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}

function main(): void {
  const name = asset();
  const recipe = pin(VERSION, [name]);
  const home = pinnedHome(NAME, recipe);
  const binary = resolve(home, 'bin', process.platform === 'win32' ? 'slangc.exe' : 'slangc');

  makeOnce(home, recipe, process.env.BOWERBIRD_REFETCH_SLANGC != null, () => {
    const url = `https://github.com/shader-slang/slang/releases/download/v${VERSION}/${name}`;
    // curl rather than wget: macOS ships one and not the other, and so does the Debian slim the
    // container builds on.
    const tarball = resolve(home, name);
    run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', tarball, url]);
    run('tar', ['xzf', tarball, '-C', home]);
    rmSync(tarball, { force: true });

    const check = spawnSync(binary, ['-v'], { encoding: 'utf8' });
    const reported = (check.stdout + check.stderr).trim();
    if (!reported.startsWith(VERSION)) {
      throw new Error(`fetched slangc reports ${reported}, wanted ${VERSION}`);
    }
  });

  linkPinned(NAME, home);
  console.log(`slangc ${VERSION} at ${binary}`);
}

main();

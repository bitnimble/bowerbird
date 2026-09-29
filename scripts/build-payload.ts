// The tarball an installed Bowerbird's updater swaps into the install (DESIGN §23.4).
//
// `--target <triple>` for a cross build; this machine's otherwise. `--out <dir>` says
// where to leave it.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostTriple } from './host-triple.ts';

const ROOT = join(import.meta.dir, '..');

/** What Rust calls a machine, against what a release names its files by. */
const PLATFORMS: Record<string, string> = {
  'aarch64-apple-darwin': 'macos-arm64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
};

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const triple = flag('target') ?? hostTriple();
const platform = PLATFORMS[triple];
if (platform == null) throw new Error(`no release is built for ${triple}`);

// Empty is unset, not the current directory - the same trap `mac-build.ts` carries a note about. `''` is not nullish, so `??` does not catch it,
// `resolve('')` is wherever this happens to be running, and the `rmSync` below would then
// take a `payload` directory out of it.
const named = flag('out')?.trim();
const out = resolve(named != null && named !== '' ? named : join(ROOT, 'dist'), platform);
const staging = join(out, 'payload');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// A cross build puts everything under the triple; a native one does not.
const releaseDir = existsSync(join(ROOT, 'src-tauri', 'target', triple))
  ? join(ROOT, 'src-tauri', 'target', triple, 'release')
  : join(ROOT, 'src-tauri', 'target', 'release');
const sidecar = join(
  ROOT,
  'src-tauri',
  'binaries',
  `bowerbird-server-${triple}${triple.includes('windows') ? '.exe' : ''}`,
);
const resources = join(ROOT, 'src-tauri', 'resources');

function need(path: string, how: string): string {
  if (!existsSync(path)) throw new Error(`${path} is not there. ${how}`);
  return path;
}

need(sidecar, 'Run `bun run build:app` first.');
need(join(resources, 'server', 'index.js'), 'Run `bun run build:app` first.');

/** The one `.app` a macOS build produced. */
function macBundle(): string {
  const bundles = join(releaseDir, 'bundle', 'macos');
  need(bundles, 'Run `bun run build:app` first.');
  const found = readdirSync(bundles).filter((entry) => entry.endsWith('.app'));
  if (found.length !== 1) {
    throw new Error(
      `${bundles} holds ${found.length} bundles, so which one ships is ambiguous: ${found.join(', ')}`,
    );
  }
  return join(bundles, found[0]!);
}

// The shell under the names `src-tauri/src/update.rs` renames to whatever it is installed as.
if (triple.includes('apple')) {
  // Copied as built: an edited bundle no longer matches its signature.
  const app = join(staging, 'Bowerbird.app');
  cpSync(macBundle(), app, { recursive: true, verbatimSymlinks: true });
  const macos = join(app, 'Contents', 'MacOS');
  // Already inside - Tauri puts the sidecar and the updater beside the executable and the
  // resources under `Contents/Resources` - so this is a check rather than a copy.
  need(join(macos, 'bowerbird-server'), 'The bundle does not hold the server.');
  need(join(macos, 'bowerbird-updater'), 'The bundle does not hold the updater.');
  need(
    join(app, 'Contents', 'Resources', 'resources', 'server', 'index.js'),
    'The bundle does not hold the server bundle.',
  );
  need(
    join(app, 'Contents', 'Resources', 'web', 'index.html'),
    'The bundle does not hold the page.',
  );
} else {
  cpSync(
    need(join(releaseDir, 'app.exe'), 'Run `bun run build:app` first.'),
    join(staging, 'bowerbird-app.exe'),
  );
  cpSync(
    need(join(releaseDir, 'bowerbird-updater.exe'), 'Run `bun run build:app` first.'),
    join(staging, 'bowerbird-updater.exe'),
  );
  cpSync(sidecar, join(staging, 'bowerbird-server.exe'));
  cpSync(resources, join(staging, 'resources'), { recursive: true });
  cpSync(need(join(ROOT, 'web', 'dist'), 'Run `bun run build:app` first.'), join(staging, 'web'), {
    recursive: true,
  });
  // Windows resolves a dependent DLL from the loading process's own directory, so whatever the
  // shell imports goes beside the executables. `rawshim.dll` adds nothing to that list: its
  // codecs are static (DESIGN §23.7.1).
  for (const entry of readdirSync(releaseDir)) {
    if (entry.toLowerCase().endsWith('.dll')) cpSync(join(releaseDir, entry), join(staging, entry));
  }
}

const name = `bowerbird-payload-${platform}.tar.gz`;
const tarball = join(out, name);
rmSync(tarball, { force: true });
// `-C … .` so the archive holds the payload's entries at its root, each of which the updater
// swaps for the install's own. Named from its own directory, because GNU tar reads `D:\…` as
// a remote `host:path` and dies trying to reach `D`.
const packed = spawnSync('tar', ['-czf', name, '-C', staging, '.'], { cwd: out, stdio: 'inherit' });
if (packed.status !== 0) process.exit(packed.status ?? 1);
rmSync(staging, { recursive: true, force: true });

console.log(`payload: ${tarball} (${(statSync(tarball).size / 1e6).toFixed(1)}MB, ${platform})`);

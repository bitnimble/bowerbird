// The tarball an installed Bowerbird unpacks over itself (DESIGN §23.4).
//
// `--target <triple>` for a cross build; this machine's otherwise. `--out <dir>` says
// where to leave it.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** What Rust calls a machine, against what a release names its files by. */
const PLATFORMS: Record<string, string> = {
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'aarch64-apple-darwin': 'macos-arm64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
};

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function hostTriple(): string {
  const probe = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('rustc is not on the path, so the target triple cannot be read');
  const line = probe.stdout.split('\n').find((entry) => entry.startsWith('host: '));
  if (line == null) throw new Error(`rustc did not report a host triple:\n${probe.stdout}`);
  return line.slice('host: '.length).trim();
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
const windows = triple.includes('windows');
const suffix = windows ? '.exe' : '';
const sidecar = join(ROOT, 'src-tauri', 'binaries', `bowerbird-server-${triple}${suffix}`);
const resources = join(ROOT, 'src-tauri', 'resources');

function need(path: string, how: string): string {
  if (!existsSync(path)) throw new Error(`${path} is not there. ${how}`);
  return path;
}

need(sidecar, 'Run `bun run build:sidecar` first.');
need(join(resources, 'server', 'index.js'), 'Run `bun run build:sidecar` first.');

/** The one `.app` a macOS build produced. */
function macBundle(): string {
  const bundles = join(releaseDir, 'bundle', 'macos');
  need(bundles, 'Run `bun run tauri build` (or `bun run mac:build`) first.');
  const found = readdirSync(bundles).filter((entry) => entry.endsWith('.app'));
  if (found.length !== 1) {
    throw new Error(`${bundles} holds ${found.length} bundles, so which one ships is ambiguous: ${found.join(', ')}`);
  }
  return join(bundles, found[0]!);
}

if (triple.includes('apple')) {
  // The whole bundle, because a window, a menu bar and a dock icon come from being
  // inside one: a bare executable run out of Application Support is a different
  // application to look at. Copied as built: the supervisor reads the executable's
  // name out of its `Info.plist`, and an edited bundle no longer matches its signature.
  const app = join(staging, 'Bowerbird.app');
  cpSync(macBundle(), app, { recursive: true, verbatimSymlinks: true });
  const macos = join(app, 'Contents', 'MacOS');
  // Already inside - Tauri puts the sidecar beside the executable and the resources
  // under `Contents/Resources` - so this is a check rather than a copy.
  need(join(macos, 'bowerbird-server'), 'The bundle does not hold the server.');
  need(join(app, 'Contents', 'Resources', 'resources', 'server', 'index.js'), 'The bundle does not hold the server bundle.');
} else {
  const app = need(join(releaseDir, `app${suffix}`), 'Run `bun run tauri build` first.');
  cpSync(app, join(staging, `bowerbird-app${suffix}`));
  cpSync(sidecar, join(staging, `bowerbird-server${suffix}`));
  cpSync(resources, join(staging, 'resources'), { recursive: true });
  // Windows resolves a dependent DLL from the loading process's own directory, so whatever the
  // shell imports goes beside the executables. `rawshim.dll` adds nothing to that list: its
  // codecs are static (DESIGN §23.7.1).
  if (windows) {
    for (const entry of readdirSync(releaseDir)) {
      if (entry.toLowerCase().endsWith('.dll')) cpSync(join(releaseDir, entry), join(staging, entry));
    }
  }
}

const name = `bowerbird-payload-${platform}.tar.gz`;
const tarball = join(out, name);
rmSync(tarball, { force: true });
// `-C … .` so the archive holds the payload's contents at its root, which is what the
// supervisor unpacks into a version directory and then runs out of. Named from its own
// directory, because GNU tar reads `D:\…` as a remote `host:path` and dies trying to reach `D`.
const packed = spawnSync('tar', ['-czf', name, '-C', staging, '.'], { cwd: out, stdio: 'inherit' });
if (packed.status !== 0) process.exit(packed.status ?? 1);
rmSync(staging, { recursive: true, force: true });

console.log(`payload: ${tarball} (${(statSync(tarball).size / 1e6).toFixed(1)}MB, ${platform})`);

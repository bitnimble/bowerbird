// The tarball an installed Bowerbird unpacks over itself (DESIGN §23.4).
//
// `--target <triple>` for a cross build; this machine's otherwise. `--out <dir>` says
// where to leave it. `--shell-only` for a platform that carries no server.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');

/** What Rust calls a machine, against what a release names its files by. */
const PLATFORMS: Record<string, string> = {
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-unknown-linux-gnu': 'linux-aarch64',
  'aarch64-apple-darwin': 'macos-aarch64',
  'x86_64-apple-darwin': 'macos-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
  'x86_64-pc-windows-gnu': 'windows-x86_64',
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

// Empty is unset, not the current directory - the same trap `mac-build.ts` and
// `win-build.ts` carry a note about. `''` is not nullish, so `??` does not catch it,
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

// A build with no server in it, which is what Windows ships: the server's half of
// `rawshim` links lensfun and the two pinned codecs, and that toolchain does not exist
// for MSVC. Such an app points at a hosted Bowerbird instead (`transport.ts`).
const shellOnly = process.argv.includes('--shell-only');

function need(path: string, how: string): string {
  if (!existsSync(path)) throw new Error(`${path} is not there. ${how}`);
  return path;
}

if (!shellOnly) {
  need(sidecar, 'Run `bun run build:sidecar` first, or pass --shell-only.');
  need(join(resources, 'server', 'index.js'), 'Run `bun run build:sidecar` first, or pass --shell-only.');
  need(join(resources, 'reference_frame.ARW'), 'Run `bun run build:sidecar` first, or pass --shell-only.');
}

/**
 * The `.app` a macOS build produced, wherever the bundler left it and whatever it called
 * the binary inside.
 *
 * Both are the bundler's to choose - `mainBinaryName` and `productName` between them
 * decide it, and which wins has moved across Tauri versions - so neither is written down
 * twice. This finds the one bundle and reads the executable's name out of its own plist.
 */
function macBundle(): { path: string; executable: string } {
  const bundles = join(releaseDir, 'bundle', 'macos');
  need(bundles, 'Run `bun run tauri build` (or `bun run mac:build`) first.');
  const found = readdirSync(bundles).filter((entry) => entry.endsWith('.app'));
  if (found.length !== 1) {
    throw new Error(`${bundles} holds ${found.length} bundles, so which one ships is ambiguous: ${found.join(', ')}`);
  }
  const path = join(bundles, found[0]!);
  const plist = readFileSync(join(path, 'Contents', 'Info.plist'), 'utf8');
  const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (executable == null) throw new Error(`${path} has no CFBundleExecutable, so nothing knows what to start`);
  return { path, executable };
}

if (triple.includes('apple')) {
  // The whole bundle, because a window, a menu bar and a dock icon come from being
  // inside one: a bare executable run out of Application Support is a different
  // application to look at.
  const bundle = macBundle();
  // Renamed into the shape `src-tauri/src/main.rs` starts, rather than that file being
  // taught every name a bundler might pick: the supervisor runs before there is a Tauri
  // context to ask, so the one place that can settle this is here, where the plist is.
  const app = join(staging, 'Bowerbird.app');
  cpSync(bundle.path, app, { recursive: true, verbatimSymlinks: true });
  const macos = join(app, 'Contents', 'MacOS');
  if (bundle.executable !== 'Bowerbird') {
    renameSync(join(macos, bundle.executable), join(macos, 'Bowerbird'));
    const plist = join(app, 'Contents', 'Info.plist');
    writeFileSync(
      plist,
      readFileSync(plist, 'utf8').replace(
        /(<key>CFBundleExecutable<\/key>\s*<string>)[^<]+(<\/string>)/,
        '$1Bowerbird$2',
      ),
    );
  }
  need(join(macos, 'Bowerbird'), 'The bundle does not hold the executable the supervisor starts.');
  if (!shellOnly) {
    // Already inside - Tauri puts the sidecar beside the executable and the resources
    // under `Contents/Resources` - so this is a check rather than a copy.
    need(join(macos, 'bowerbird-server'), 'The bundle does not hold the server.');
    need(join(app, 'Contents', 'Resources', 'resources', 'server', 'index.js'), 'The bundle does not hold the server bundle.');
  }
} else {
  const app = need(join(releaseDir, `app${suffix}`), 'Run `bun run tauri build` first.');
  cpSync(app, join(staging, `bowerbird-app${suffix}`));
  if (!shellOnly) {
    cpSync(sidecar, join(staging, `bowerbird-server${suffix}`));
    cpSync(resources, join(staging, 'resources'), { recursive: true });
  }
  // Windows resolves an import from the executable's own directory first, and a MinGW
  // build carries its runtime beside the exe rather than expecting it on the machine.
  if (windows) {
    for (const entry of readdirSync(releaseDir)) {
      if (entry.toLowerCase().endsWith('.dll')) cpSync(join(releaseDir, entry), join(staging, entry));
    }
  }
}

const tarball = join(out, `bowerbird-payload-${platform}.tar.gz`);
rmSync(tarball, { force: true });
// `-C … .` so the archive holds the payload's contents at its root, which is what the
// supervisor unpacks into a version directory and then runs out of.
const packed = spawnSync('tar', ['-czf', tarball, '-C', staging, '.'], { stdio: 'inherit' });
if (packed.status !== 0) process.exit(packed.status ?? 1);
rmSync(staging, { recursive: true, force: true });

console.log(`payload: ${tarball} (${(statSync(tarball).size / 1e6).toFixed(1)}MB, ${platform})`);

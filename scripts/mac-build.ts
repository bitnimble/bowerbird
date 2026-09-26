// Cross-build the macOS `.app` from Linux, via osxcross. Dev testing only.
//
// Unsigned and unnotarised, so the first launch is right-click > Open. Modelled on
// utai.au's `scripts/mac-build.ts`.
//
// One-time host prereqs: `rustup target add aarch64-apple-darwin` and an
// osxcross toolchain with the Xcode-extracted macOS SDK (Apple's is not redistributable,
// which is why this cannot be a `bun install`).
//
// `BOWERBIRD_MAC_DIST_DIR` says where to leave the bundle; where Tauri's bundler would otherwise,
// which is where `build-payload.ts` looks for it.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';
import { MAC_MIN_VERSION, MAC_TARGET as TARGET, osxcrossEnv } from './osxcross.ts';
import { VERSION } from '../src/version.ts';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP_NAME = 'Bowerbird.app';

let env: Record<string, string>;
try {
  env = osxcrossEnv();
} catch (failed) {
  console.error(`[mac-build] ${(failed as Error).message}`);
  process.exit(1);
}

// `tauri build` on Linux offers deb/rpm/appimage and no macOS bundler, so this builds the
// bare binary and assembles the bundle below. A `.app` is a directory with a plist in it.
ensureIcons();

const config = JSON.stringify({ version: VERSION });
const args = ['build', '--target', TARGET, '--no-bundle', '--config', config, ...process.argv.slice(2)];
const built = spawnSync('bun', ['x', '@tauri-apps/cli', ...args], { stdio: 'inherit', env });
if (built.status !== 0) process.exit(built.status ?? 1);

const repoRoot = resolve(import.meta.dir, '..');
const releaseDir = join(repoRoot, 'src-tauri', 'target', TARGET, 'release');
const binary = join(releaseDir, 'app');
if (!existsSync(binary)) {
  console.error(`[mac-build] built, but ${binary} is missing`);
  process.exit(1);
}

const conf = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const EXE = 'app';

function infoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key><string>en</string>
\t<key>CFBundleExecutable</key><string>${EXE}</string>
\t<key>CFBundleIdentifier</key><string>${conf.identifier}</string>
\t<key>CFBundleName</key><string>${conf.productName}</string>
\t<key>CFBundleDisplayName</key><string>${conf.productName}</string>
\t<key>CFBundlePackageType</key><string>APPL</string>
\t<key>CFBundleShortVersionString</key><string>${VERSION}</string>
\t<key>CFBundleVersion</key><string>${VERSION}</string>
\t<key>CFBundleIconFile</key><string>icon.icns</string>
\t<key>LSMinimumSystemVersion</key><string>${MAC_MIN_VERSION}</string>
\t<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

// Empty is unset, not the current directory: `resolve('')` is wherever this is running, and
// the `rmSync` below would then delete `Bowerbird.app` out of it.
const dist = process.env.BOWERBIRD_MAC_DIST_DIR?.trim();
const appDir = dist ? join(resolve(dist), APP_NAME) : join(releaseDir, 'bundle', 'macos', APP_NAME);
mkdirSync(resolve(appDir, '..'), { recursive: true });

rmSync(appDir, { recursive: true, force: true });
const contents = join(appDir, 'Contents');
const macos = join(contents, 'MacOS');
const resources = join(contents, 'Resources');
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });

copyFileSync(binary, join(macos, EXE));
chmodSync(join(macos, EXE), 0o755);

// No `Frameworks`, and nothing to patch into it: the only things left in the load commands
// are macOS's own, so the linker's ad-hoc signature still describes the file it signed,
// which is what makes the bundle launchable at all.

// The server the app carries (docs/replication.md §13, milestone 4). Beside the
// executable, because that is where the shell looks for a sidecar, and its bundle
// and native library under Resources, because that is what `resource_dir()`
// answers on macOS.
//
// **Cross-built from Linux, this is the one part that cannot be made here.** The
// sidecar is the Bun runtime itself, and `build-sidecar.ts` copies the one it is
// running - a Linux binary, useless in a `.app`. Set `BOWERBIRD_SIDECAR_RUNTIME`
// to a macOS `bun` and run `build:sidecar` before this, or accept an app that
// opens and finds no library.
const sidecarSource = join(repoRoot, 'src-tauri', 'binaries', `bowerbird-server-${TARGET}`);
const bundledServer = join(repoRoot, 'src-tauri', 'resources');
if (existsSync(sidecarSource) && existsSync(join(bundledServer, 'server', 'index.js'))) {
  copyFileSync(sidecarSource, join(macos, 'bowerbird-server'));
  chmodSync(join(macos, 'bowerbird-server'), 0o755);
  cpSync(bundledServer, join(resources, 'resources'), { recursive: true });
} else {
  console.error(
    `[mac-build] no server at ${sidecarSource}: this .app will open and find no library. ` +
      'Build one with BOWERBIRD_SIDECAR_RUNTIME=<a macOS bun> bun run build:sidecar --target ' +
      TARGET,
  );
}

const icon = join(repoRoot, 'src-tauri', 'icons', 'icon.icns');
if (existsSync(icon)) copyFileSync(icon, join(resources, 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), infoPlist());
writeFileSync(join(contents, 'PkgInfo'), 'APPL????');

console.error(`[mac-build] app: ${appDir} (unsigned; right-click > Open on first launch)`);

// Cross-build the macOS `.app` from Linux, via osxcross. Dev testing only.
//
// Unsigned and unnotarised, so the first launch is right-click > Open. Modelled on
// utai.au's `scripts/mac-build.ts`.
//
// One-time host prereqs: `rustup target add aarch64-apple-darwin` and an
// osxcross toolchain with the Xcode-extracted macOS SDK (Apple's is not redistributable,
// which is why this cannot be a `bun install`).
//
// `BOWERBIRD_MAC_DIST_DIR` says where to leave the bundle; the target dir otherwise.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';
import { VERSION } from '../src/version.ts';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const TARGET = process.env.BOWERBIRD_MAC_TARGET ?? 'aarch64-apple-darwin';
// wry's objc2 bindings want a deployment target this recent; osxcross defaults it lower.
const MAC_MIN_VERSION = '11.0';
const APP_NAME = 'Bowerbird.app';

const root = process.env.OSXCROSS_ROOT;
if (root == null || !existsSync(root)) {
  console.error('[mac-build] set OSXCROSS_ROOT to an osxcross target directory');
  process.exit(1);
}

// Everything derived from the triple, so an x86_64 build works the same way. The `ar`
// carries the SDK's darwin version in its name, so it has to be discovered.
const bin = join(root, 'bin');
const isArm = TARGET.startsWith('aarch64');
const clang = isArm ? 'oa64-clang' : 'o64-clang';
const arch = isArm ? 'aarch64' : 'x86_64';
const ar = readdirSync(bin).find((f) => f.startsWith(`${arch}-apple-darwin`) && f.endsWith('-ar'));
const under = TARGET.replaceAll('-', '_');
const upper = under.toUpperCase();
const sdk =
  process.env.SDKROOT ??
  (() => {
    const sdks = join(root, 'SDK');
    const found = existsSync(sdks) ? readdirSync(sdks).find((n) => n.startsWith('MacOSX')) : undefined;
    return found ? join(sdks, found) : undefined;
  })();

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: `${bin}:${process.env.PATH ?? ''}`,
  [`CARGO_TARGET_${upper}_LINKER`]: clang,
  [`CC_${under}`]: clang,
  [`CXX_${under}`]: `${clang}++`,
  ...(ar != null && { [`AR_${under}`]: ar }),
  MACOSX_DEPLOYMENT_TARGET: MAC_MIN_VERSION,
  // The SDK on the link path, and only because of `iconv`. Rust's std links `-liconv` on
  // this target, and it has to resolve to the system stub: a GNU libiconv would leave an
  // absolute path in the load commands of a bundle that ships no such file, and it is LGPL
  // where macOS provides one already.
  ...(sdk != null && {
    [`CARGO_TARGET_${upper}_RUSTFLAGS`]: `-L native=${join(sdk, 'usr', 'lib')}`,
  }),
  // Kept for the linker rather than for bindgen: an editor build parses no C headers at all
  // now, so there is nothing for bindgen's own clang to be pointed at.
  ...(sdk != null && { SDKROOT: sdk }),
};

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

// Empty is unset, not the current directory: `''.trim()` is not null, so the old test took
// the dist branch for `BOWERBIRD_MAC_DIST_DIR=`, `resolve('')` is wherever this is running,
// and the `rmSync` below would then delete `Bowerbird.app` out of the repo.
const dist = process.env.BOWERBIRD_MAC_DIST_DIR?.trim();
const appDir = dist ? join(resolve(dist), APP_NAME) : join(releaseDir, APP_NAME);
if (dist) mkdirSync(resolve(dist), { recursive: true });

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

// Cross-build the macOS `.app` from Linux, via osxcross. Dev testing only.
//
// Unsigned and unnotarised, so the first launch is right-click > Open. Modelled on
// utai.au's `scripts/mac-build.ts`.
//
// **No MacPorts tree is needed any more.** The shell builds `rawshim` without
// `renditions`, which now links no C at all - the RAW decoder is rawler, the demosaic and
// the grade are WGSL, and the JPEG codec either side is Rust. What used to be here was a
// MacPorts fetch of libraw, jpeg, lcms2 and zlib, and a static link of all four, done for a
// code-signing reason: `install_name_tool` repointing the dylibs rewrote load commands in
// page 0 of `__TEXT`, which broke the ad-hoc signature and got the process killed on arm64.
// With nothing to relocate, none of that applies.
//
// One-time host prereqs: `rustup target add aarch64-apple-darwin` and an
// osxcross toolchain with the Xcode-extracted macOS SDK (Apple's is not redistributable,
// which is why this cannot be a `bun install`).
//
// `BOWERBIRD_MAC_DIST_DIR` says where to leave the bundle; the target dir otherwise.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';
import {
  chmodSync,
  copyFileSync,
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

const args = ['build', '--target', TARGET, '--no-bundle', ...process.argv.slice(2)];
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
\t<key>CFBundleShortVersionString</key><string>${conf.version}</string>
\t<key>CFBundleVersion</key><string>${conf.version}</string>
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

const icon = join(repoRoot, 'src-tauri', 'icons', 'icon.icns');
if (existsSync(icon)) copyFileSync(icon, join(resources, 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), infoPlist());
writeFileSync(join(contents, 'PkgInfo'), 'APPL????');

console.error(`[mac-build] app: ${appDir} (unsigned; right-click > Open on first launch)`);

// Cross-build the macOS `.app` from Linux, via osxcross. Dev testing only.
//
// Unsigned and unnotarised, so the first launch is right-click > Open. Modelled on
// utai.au's `scripts/mac-build.ts`, with one difference that is the whole difficulty: the
// shell builds `rawshim` without `renditions`, so it links LibRaw - and the target needs
// that built for arm64 Darwin before any of this compiles. osxcross's MacPorts fetcher
// supplies it, with the two libraries LibRaw's own build linked against:
//
//   export OSXCROSS_ROOT=~/osxcross/target MACOSX_DEPLOYMENT_TARGET=11.0
//   export PATH="$OSXCROSS_ROOT/bin:$PATH" OSXCROSS_MACPORTS_MIRROR=https://packages.macports.org
//   osxcross-macports install --arm64 libraw jpeg lcms2 zlib
//
// Linked statically, which is a correctness decision rather than a size one - see
// `RAWSHIM_LIBRAW_STATIC` below for the code-signing reason.
//
// One-time host prereqs beyond that: `rustup target add aarch64-apple-darwin` and an
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

// The MacPorts tree osxcross installed the C libraries into. `build.rs` finds them through
// pkg-config, which needs pointing at the target's `.pc` files and told not to fall back to
// the host's - a Linux `libraw.pc` here would link an ELF into a Mach-O.
const macports = join(root, 'macports', 'pkgs', 'opt', 'local');
if (!existsSync(join(macports, 'lib', 'pkgconfig', 'libraw.pc'))) {
  console.error(`[mac-build] no LibRaw for ${TARGET} in ${macports}`);
  console.error('[mac-build] osxcross-macports install --arm64 libraw jpeg lcms2 zlib');
  process.exit(1);
}

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: `${bin}:${process.env.PATH ?? ''}`,
  [`CARGO_TARGET_${upper}_LINKER`]: clang,
  [`CC_${under}`]: clang,
  [`CXX_${under}`]: `${clang}++`,
  ...(ar != null && { [`AR_${under}`]: ar }),
  MACOSX_DEPLOYMENT_TARGET: MAC_MIN_VERSION,
  // Cross pkg-config, and only the target's tree: a host `libraw.pc` here would put an
  // ELF's headers in front of a Mach-O link.
  [`PKG_CONFIG_PATH_${under}`]: join(macports, 'lib', 'pkgconfig'),
  PKG_CONFIG_ALLOW_CROSS: '1',
  PKG_CONFIG_LIBDIR: join(macports, 'lib', 'pkgconfig'),
  // `build.rs` names LibRaw but leaves the search path to the system, which on a cross build
  // is the wrong system. This is where it actually is.
  //
  // The SDK first, and only because of `iconv`. Rust's std links `-liconv` on this target,
  // and with only MacPorts on the path that resolved to its GNU build - leaving
  // `/opt/local/lib/libiconv.2.dylib` in the load commands of a bundle that ships no such
  // file, and GNU libiconv is LGPL where macOS provides one as a system library. Searching
  // the SDK first hands `-liconv` the system stub instead. It shadows nothing else here:
  // the SDK carries `.tbd` stubs where the three below are asked for as `static=`, which
  // only an `.a` satisfies, and it has no jpeg or lcms2 at all.
  [`CARGO_TARGET_${upper}_RUSTFLAGS`]: [
    ...(sdk != null ? [`-L native=${join(sdk, 'usr', 'lib')}`] : []),
    `-L native=${join(macports, 'lib')}`,
  ].join(' '),
  // Statically, which is not a size decision. The linker ad-hoc signs the binary, and this
  // bundle used to be patched afterwards with `install_name_tool` to repoint
  // `/opt/local/lib/*` at `@executable_path/../Frameworks` - which rewrites load commands in
  // page 0 of `__TEXT`, so code directory slot 0 stops matching the file. arm64 macOS
  // validates every page as it is paged in, so the first page dyld touched was rejected and
  // the kernel killed the process before any app code ran: `Code Signature Invalid`,
  // `Invalid Page`, faulting inside dyld's own header read. Rehashing the slots showed it
  // exactly - 0 of 2159 mismatched as linked, 1 of 2159 after a single `-change`, and the
  // MacPorts dylibs break the same way, so no ordering of the patching saves it. Linking the
  // archive in means there is nothing to patch and the linker's signature stays valid.
  RAWSHIM_LIBRAW_DIR: join(macports, 'lib'),
  RAWSHIM_LIBRAW_STATIC: '1',
  // bindgen runs its own clang over the C headers and does not inherit any of the above.
  ...(sdk != null && {
    SDKROOT: sdk,
    BINDGEN_EXTRA_CLANG_ARGS: `-isysroot ${sdk} --target=${TARGET} -I${join(macports, 'include')}`,
  }),
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

// No `Frameworks`, and nothing to patch into it. LibRaw and the two libraries it wants are
// in the binary (`RAWSHIM_LIBRAW_STATIC` above), so the only things left in the load
// commands are macOS's own - and the linker's ad-hoc signature still describes the file it
// signed, which is what makes the bundle launchable at all.

const icon = join(repoRoot, 'src-tauri', 'icons', 'icon.icns');
if (existsSync(icon)) copyFileSync(icon, join(resources, 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), infoPlist());
writeFileSync(join(contents, 'PkgInfo'), 'APPL????');

console.error(`[mac-build] app: ${appDir} (unsigned; right-click > Open on first launch)`);

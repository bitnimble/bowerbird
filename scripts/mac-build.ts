// Cross-build the macOS `.app` from Linux, via osxcross. Dev testing only.
//
// Unsigned and unnotarised, so the first launch is right-click > Open. Modelled on
// utai.au's `scripts/mac-build.ts`, with one difference that is the whole difficulty:
// `rawshim` links LibRaw, lensfun and libavif, so the target needs those three built for
// arm64 Darwin before any of this compiles. osxcross's MacPorts fetcher supplies them:
//
//   export OSXCROSS_ROOT=~/osxcross/target MACOSX_DEPLOYMENT_TARGET=11.0
//   export PATH="$OSXCROSS_ROOT/bin:$PATH" OSXCROSS_MACPORTS_MIRROR=https://packages.macports.org
//   osxcross-macports install --arm64 libraw lensfun libavif
//
// One-time host prereqs beyond that: `rustup target add aarch64-apple-darwin` and an
// osxcross toolchain with the Xcode-extracted macOS SDK (Apple's is not redistributable,
// which is why this cannot be a `bun install`).
//
// `BOWERBIRD_MAC_DIST_DIR` says where to leave the bundle; the target dir otherwise.
import { spawnSync } from 'node:child_process';
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
  console.error('[mac-build] osxcross-macports install --arm64 libraw lensfun libavif');
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
  // `build.rs` names LibRaw, lensfun and libavif but leaves the search path to the system,
  // which on a cross build is the wrong system. This is where they actually are.
  [`CARGO_TARGET_${upper}_RUSTFLAGS`]: `-L native=${join(macports, 'lib')}`,
  // bindgen runs its own clang over the C headers and does not inherit any of the above.
  ...(sdk != null && {
    SDKROOT: sdk,
    BINDGEN_EXTRA_CLANG_ARGS: `-isysroot ${sdk} --target=${TARGET} -I${join(macports, 'include')}`,
  }),
};

// `tauri build` on Linux offers deb/rpm/appimage and no macOS bundler, so this builds the
// bare binary and assembles the bundle below. A `.app` is a directory with a plist in it.
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

const dist = process.env.BOWERBIRD_MAC_DIST_DIR?.trim();
const appDir = dist == null ? join(releaseDir, APP_NAME) : join(resolve(dist), APP_NAME);
if (dist != null) mkdirSync(resolve(dist), { recursive: true });

rmSync(appDir, { recursive: true, force: true });
const contents = join(appDir, 'Contents');
const macos = join(contents, 'MacOS');
const resources = join(contents, 'Resources');
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });

copyFileSync(binary, join(macos, EXE));
chmodSync(join(macos, EXE), 0o755);

// The three C libraries travel with the bundle: a test Mac has no MacPorts, and the
// binary was linked against `/opt/local/lib`. `install_name_tool` repoints it at
// `@executable_path/../Frameworks`, which is where a `.app` keeps its dylibs.
const frameworks = join(contents, 'Frameworks');
mkdirSync(frameworks, { recursive: true });
// Everything resolvable in the tree, rather than the binary's exact closure: a few
// megabytes of ncurses is cheaper than an `otool` walk, and MacPorts leaves some absolute
// symlinks (openssl into `/opt/local/libexec`) which point nowhere on this machine and
// which nothing here links against anyway.
const shipped = readdirSync(join(macports, 'lib')).filter(
  (f) => f.endsWith('.dylib') && existsSync(join(macports, 'lib', f)),
);
for (const lib of shipped) copyFileSync(join(macports, 'lib', lib), join(frameworks, lib));

const named = readdirSync(bin).find(
  (f) => f.startsWith(`${arch}-apple-darwin`) && f.endsWith('-install_name_tool'),
);
if (named == null) {
  console.error(`[mac-build] no install_name_tool for ${arch} in ${bin}`);
  process.exit(1);
}
const tool = join(bin, named);
for (const lib of shipped) {
  const inside = `@executable_path/../Frameworks/${lib}`;
  spawnSync(tool, ['-change', `/opt/local/lib/${lib}`, inside, join(macos, EXE)], { stdio: 'ignore' });
  // Its own name, so anything that reads it back agrees with where it is. dyld loads by
  // the path in the *loader*, so this is tidiness rather than function - but a bundle
  // whose libraries claim to live in a MacPorts prefix invites a confusing afternoon.
  spawnSync(tool, ['-id', inside, join(frameworks, lib)], { stdio: 'ignore' });
  // And their references to each other, or those resolve to a tree that is not there.
  for (const other of shipped) {
    spawnSync(
      tool,
      ['-change', `/opt/local/lib/${other}`, `@executable_path/../Frameworks/${other}`, join(frameworks, lib)],
      { stdio: 'ignore' },
    );
  }
}

const icon = join(repoRoot, 'src-tauri', 'icons', 'icon.icns');
if (existsSync(icon)) copyFileSync(icon, join(resources, 'icon.icns'));
writeFileSync(join(contents, 'Info.plist'), infoPlist());
writeFileSync(join(contents, 'PkgInfo'), 'APPL????');

console.error(`[mac-build] app: ${appDir} (unsigned; right-click > Open on first launch)`);

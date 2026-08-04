// Build the Android APK. Dev testing only, unsigned.
//
// The shell links `rawshim` without its `renditions` feature, so the only C library it
// needs for the target is LibRaw - the editor's open never touches lensfun or libavif.
// That matters here more than anywhere: lensfun has no prebuilt Android build anywhere and
// wants glib, which is the one thing that would have made this a project rather than a
// script.
//
// LibRaw for `aarch64-linux-android` comes from Termux, which is a prebuilt Android
// repository and the same move osxcross-macports and MSYS2 make for the other two targets:
//
//   bun run scripts/termux-fetch.ts libraw libraw-static
//
// Linked static, so the APK carries no dependency on Termux's own prefix at runtime.
//
// One-time host prereqs: `rustup target add aarch64-linux-android`, an Android SDK with
// NDK 27, and a JDK 17. `ANDROID_HOME` and `ANDROID_SDK_ROOT` must agree - Gradle refuses
// to guess when they disagree, which is its way of saying the build would be
// irreproducible.
import { spawnSync } from 'node:child_process';
import { ensureIcons } from './make-icons.ts';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TARGET = 'aarch64-linux-android';
const under = TARGET.replaceAll('-', '_');

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (sdk == null || !existsSync(sdk)) {
  console.error('[android-build] set ANDROID_HOME to an Android SDK');
  process.exit(1);
}
const ndkRoot = join(sdk, 'ndk');
const ndk =
  process.env.NDK_HOME ??
  (existsSync(ndkRoot) ? join(ndkRoot, readdirSync(ndkRoot).sort().reverse()[0] ?? '') : '');
if (!existsSync(ndk)) {
  console.error(`[android-build] no NDK under ${ndkRoot}`);
  process.exit(1);
}

// Where `termux-fetch` put LibRaw. Termux packages carry their own absolute prefix, which
// is why this path looks like a phone's.
const prefix = process.env.TERMUX_PREFIX ?? '/tmp/android-prefix';
const usr = join(prefix, 'data', 'data', 'com.termux', 'files', 'usr');
if (!existsSync(join(usr, 'lib', 'libraw.a'))) {
  console.error(`[android-build] no LibRaw for ${TARGET} in ${usr}`);
  console.error('[android-build] bun run scripts/termux-fetch.ts libraw libraw-static');
  process.exit(1);
}

const toolchain = join(ndk, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
// API 24 is what the NDK's own linker wrappers are named for and what Termux builds
// against, so the two agree about which libc symbols exist.
const clang = join(toolchain, `aarch64-linux-android24-clang`);

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  NDK_HOME: ndk,
  [`CC_${under}`]: clang,
  [`CXX_${under}`]: `${clang}++`,
  [`AR_${under}`]: join(toolchain, 'llvm-ar'),
  // Only the target's `.pc` files; a host `libraw.pc` here would be an x86 ELF's flags.
  [`PKG_CONFIG_PATH_${under}`]: join(usr, 'lib', 'pkgconfig'),
  PKG_CONFIG_ALLOW_CROSS: '1',
  PKG_CONFIG_LIBDIR: join(usr, 'lib', 'pkgconfig'),
  // Read by `rawshim`'s build script rather than passed as rustflags: Tauri's Android
  // build sets `CARGO_TARGET_<triple>_RUSTFLAGS` for its own linker arguments and
  // overwrites whatever was there, where a build script's directives are merged.
  RAWSHIM_LIBRAW_DIR: join(usr, 'lib'),
  RAWSHIM_LIBRAW_STATIC: '1',
  // The sysroot is not optional: bindgen runs its own clang, and without one it reads the
  // host's `/usr/include` and fails on the first glibc header an Android build has no
  // business seeing.
  BINDGEN_EXTRA_CLANG_ARGS: [
    `--target=${TARGET}`,
    `--sysroot=${join(toolchain, '..', 'sysroot')}`,
    `-I${join(usr, 'include')}`,
  ].join(' '),
};

ensureIcons();

const args = ['android', 'build', '--target', 'aarch64', '--apk', ...process.argv.slice(2)];
const built = spawnSync('bun', ['x', '@tauri-apps/cli', ...args], { stdio: 'inherit', env });
if (built.status !== 0) process.exit(built.status ?? 1);

// Gradle leaves the APK under the generated project; copy it somewhere a phone can reach.
const repoRoot = resolve(import.meta.dir, '..');
const outputs = join(repoRoot, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
const found: string[] = [];
const walk = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.apk')) found.push(path);
  }
};
walk(outputs);
if (found.length === 0) {
  console.error(`[android-build] built, but no APK under ${outputs}`);
  process.exit(1);
}

// One APK, chosen rather than whichever the walk reached last. Every match used to be
// copied to the same `Bowerbird.apk` in turn, so what shipped was the last one found - and
// nothing cleans this tree, so it holds whatever earlier builds left in it.
//
// Chosen by build type, not by the word "unsigned". Nothing here configures signing, so the
// release APK this produces IS `app-universal-release-unsigned.apk` - filtering that word
// out selects a debug APK from an earlier `tauri android dev` instead, leaves exactly one
// candidate so the check below stays quiet, and ships it.
const release = found.filter((apk) => /[/\\]release[/\\]/.test(apk));
const chosen = release.length > 0 ? release : found;
if (chosen.length > 1) {
  console.error(`[android-build] ${chosen.length} APKs under ${outputs}, so which one ships is ambiguous:`);
  for (const apk of chosen) console.error(`  ${apk}`);
  console.error('[android-build] clear the outputs tree and build again');
  process.exit(1);
}

// Empty is unset, not the current directory: `''.trim()` is not null, and `resolve('')` is
// wherever this happens to be running.
const dist = process.env.BOWERBIRD_ANDROID_DIST_DIR?.trim();
const apk = chosen[0]!;
if (dist) {
  mkdirSync(resolve(dist), { recursive: true });
  copyFileSync(apk, join(resolve(dist), 'Bowerbird.apk'));
}
console.error(`[android-build] apk: ${dist ? join(resolve(dist), 'Bowerbird.apk') : apk}`);

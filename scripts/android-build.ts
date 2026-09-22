// Build the Android APK. Dev testing only, unsigned.
//
// The shell links `rawshim` without its `renditions` feature, so nothing here needs a C library
// cross-built for the target: rawler reads the RAWs, the lens database is `lensdb`, the demosaic
// and the grade are WGSL, and the JPEG codec either side is Rust.
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

const toolchain = join(ndk, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
// API 24, which is what the NDK's own linker wrappers are named for.
const clang = join(toolchain, `aarch64-linux-android24-clang`);

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  NDK_HOME: ndk,
  [`CC_${under}`]: clang,
  [`CXX_${under}`]: `${clang}++`,
  [`AR_${under}`]: join(toolchain, 'llvm-ar'),
};

ensureIcons();

// The Gradle project, on the same terms as the icons: it bakes in this machine's SDK paths, so it
// is generated rather than committed and a fresh checkout has none.
const repoRoot = resolve(import.meta.dir, '..');
if (!existsSync(join(repoRoot, 'src-tauri', 'gen', 'android'))) {
  const started = spawnSync('bun', ['x', '@tauri-apps/cli', 'android', 'init'], {
    stdio: 'inherit',
    env,
  });
  if (started.status !== 0) process.exit(started.status ?? 1);
}

const args = ['android', 'build', '--target', 'aarch64', '--apk', ...process.argv.slice(2)];
const built = spawnSync('bun', ['x', '@tauri-apps/cli', ...args], { stdio: 'inherit', env });
if (built.status !== 0) process.exit(built.status ?? 1);

// Gradle leaves the APK under the generated project; copy it somewhere a phone can reach.
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

// One APK, chosen rather than whichever the walk reached last: nothing cleans this tree, so it
// holds whatever earlier builds left in it.
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

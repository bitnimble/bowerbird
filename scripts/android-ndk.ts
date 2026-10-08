// The Android SDK, the NDK `.android-ndk-version` pins, and what a cross build for the phone needs
// from them.
//
// `ANDROID_HOME` and `ANDROID_SDK_ROOT` must agree - Gradle refuses to guess when they disagree.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ANDROID_TARGET = 'aarch64-linux-android';
/** The app's `minSdk`, which the NDK's compiler wrappers are named for. */
export const ANDROID_API = 24;
export const ANDROID_ABI = 'arm64-v8a';
export const ANDROID_PAGE_SIZE = 16384;
/** Play refuses an app whose libraries cannot load on a 16 KB page device; r27 links for 4 KB. */
export const ANDROID_PAGE_SIZE_LINK_ARG = `-Wl,-z,max-page-size=${ANDROID_PAGE_SIZE}`;

export interface AndroidNdk {
  ndk: string;
  /** The NDK's compilers and binutils. */
  bin: string;
  sysroot: string;
  /** What `cc`, `cmake`, cargo and bindgen need to build for the phone rather than for this machine. */
  env: Record<string, string>;
}

export function androidNdk(): AndroidNdk {
  const version = readFileSync(resolve(import.meta.dir, '../.android-ndk-version'), 'utf8').trim();
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk == null || !existsSync(sdk)) throw new Error('set ANDROID_HOME to an Android SDK');
  const ndk = process.env.NDK_HOME ?? join(sdk, 'ndk', version);
  if (!existsSync(ndk)) {
    throw new Error(`no NDK at ${ndk}: sdkmanager --install "ndk;${version}"`);
  }
  // The NDK's macOS toolchain is universal under this name.
  const prebuilt = join(
    ndk,
    'toolchains',
    'llvm',
    'prebuilt',
    process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64',
  );
  const bin = join(prebuilt, 'bin');
  const sysroot = join(prebuilt, 'sysroot');
  const clang = join(bin, `${ANDROID_TARGET}${ANDROID_API}-clang`);
  const under = ANDROID_TARGET.replaceAll('-', '_');
  return {
    ndk,
    bin,
    sysroot,
    env: {
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      NDK_HOME: ndk,
      ANDROID_NDK_HOME: ndk,
      [`CC_${under}`]: clang,
      [`CXX_${under}`]: `${clang}++`,
      [`AR_${under}`]: join(bin, 'llvm-ar'),
      [`CARGO_TARGET_${under.toUpperCase()}_LINKER`]: clang,
      [`CARGO_TARGET_${under.toUpperCase()}_RUSTFLAGS`]: `-C link-arg=${ANDROID_PAGE_SIZE_LINK_ARG}`,
      // Without it libclang reads this machine's headers and bindgen lays structs out for them.
      [`BINDGEN_EXTRA_CLANG_ARGS_${under}`]: `--sysroot=${sysroot}`,
    },
  };
}

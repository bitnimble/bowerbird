// The environment a cargo build for macOS needs on Linux, from the osxcross at `OSXCROSS_ROOT`.
//
//   bun run scripts/osxcross.ts <command...>
//
// runs a command in it, which is how the native library is cross-built before `mac-build.ts`
// builds the shell.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MAC_TARGET = process.env.BOWERBIRD_MAC_TARGET ?? 'aarch64-apple-darwin';
// wry's objc2 bindings want a deployment target this recent; osxcross defaults it lower.
export const MAC_MIN_VERSION = '11.0';

export function osxcrossEnv(): Record<string, string> {
  const root = process.env.OSXCROSS_ROOT;
  if (root == null || !existsSync(root)) {
    throw new Error('set OSXCROSS_ROOT to an osxcross target directory');
  }

  // Everything derived from the triple, so an x86_64 build works the same way. The `ar`
  // carries the SDK's darwin version in its name, so it has to be discovered.
  const bin = join(root, 'bin');
  const isArm = MAC_TARGET.startsWith('aarch64');
  const clang = isArm ? 'oa64-clang' : 'o64-clang';
  const arch = isArm ? 'aarch64' : 'x86_64';
  const ar = readdirSync(bin).find((f) => f.startsWith(`${arch}-apple-darwin`) && f.endsWith('-ar'));
  const under = MAC_TARGET.replaceAll('-', '_');
  const upper = under.toUpperCase();
  const sdk =
    process.env.SDKROOT ??
    (() => {
      const sdks = join(root, 'SDK');
      const found = existsSync(sdks) ? readdirSync(sdks).find((n) => n.startsWith('MacOSX')) : undefined;
      return found ? join(sdks, found) : undefined;
    })();

  return {
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
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command == null) {
    console.error('usage: bun run scripts/osxcross.ts <command...>');
    process.exit(2);
  }
  const done = spawnSync(command, args, { stdio: 'inherit', env: osxcrossEnv() });
  process.exit(done.status ?? 1);
}

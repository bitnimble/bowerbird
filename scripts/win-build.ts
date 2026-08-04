// Cross-build the Windows app from Linux, via MinGW. Dev testing only.
//
// `x86_64-pc-windows-gnu`, not `-msvc`, and that choice is the whole reason this is
// possible here. `rawshim` links LibRaw, lensfun and libavif, so a Windows build needs
// those three built for Windows first - and for MSVC there is no way to get them on a
// Linux box short of a vcpkg-from-source project (lensfun wants glib). MSYS2 ships them
// prebuilt for MinGW, and its packages are zstd tarballs over HTTP, so the same trick that
// osxcross-macports plays for the Mac works here:
//
//   bun /tmp/msys_fetch.mjs libraw lensfun libavif      # see scripts/msys-fetch.ts
//
// One-time host prereqs: `rustup target add x86_64-pc-windows-gnu`, and a mingw-w64 cross
// toolchain (`gcc-mingw-w64-x86-64-posix`, `binutils-mingw-w64-x86-64`,
// `mingw-w64-x86-64-dev`). Unsigned, and no NSIS installer - a folder with an `.exe` and
// its DLLs, which is enough to run it.
//
// `BOWERBIRD_WIN_DIST_DIR` says where to leave it; the target dir otherwise.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TARGET = 'x86_64-pc-windows-gnu';
const under = TARGET.replaceAll('-', '_');
const upper = under.toUpperCase();

// Where `msys-fetch` put the MSYS2 tree. It nests a `mingw64` inside the prefix, which is
// the layout the packages carry.
const prefix = process.env.MSYS_PREFIX ?? join(process.env.HOME ?? '', 'local', 'mingw64');
const mingw = join(prefix, 'mingw64');
if (!existsSync(join(mingw, 'lib', 'pkgconfig', 'libraw.pc'))) {
  console.error(`[win-build] no LibRaw for ${TARGET} in ${mingw}`);
  console.error('[win-build] bun run scripts/msys-fetch.ts libraw lensfun libavif');
  process.exit(1);
}

// The `-posix` variants: the `-win32` threading model has no `std::mutex`, which LibRaw's
// C++ wants, and rustc's own std expects POSIX threads on this target anyway.
const gcc = 'x86_64-w64-mingw32-gcc-posix';
const gxx = 'x86_64-w64-mingw32-g++-posix';

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  [`CARGO_TARGET_${upper}_LINKER`]: gcc,
  [`CC_${under}`]: gcc,
  [`CXX_${under}`]: gxx,
  AR_x86_64_pc_windows_gnu: 'x86_64-w64-mingw32-ar',
  // Only the target's `.pc` files: a host `libraw.pc` here would put an ELF's flags in
  // front of a PE link.
  [`PKG_CONFIG_PATH_${under}`]: join(mingw, 'lib', 'pkgconfig'),
  PKG_CONFIG_ALLOW_CROSS: '1',
  PKG_CONFIG_LIBDIR: join(mingw, 'lib', 'pkgconfig'),
  // `build.rs` names the libraries and leaves the search path to the system, which on a
  // cross build is the wrong system. And bindgen runs its own clang, inheriting none of it.
  [`CARGO_TARGET_${upper}_RUSTFLAGS`]: `-L native=${join(mingw, 'lib')}`,
  BINDGEN_EXTRA_CLANG_ARGS: `--target=${TARGET} -I${join(mingw, 'include')}`,
};

// `--no-bundle`: Tauri's NSIS bundler wants `makensis.exe`, and a folder of files is
// enough to run the thing.
const args = ['build', '--target', TARGET, '--no-bundle', ...process.argv.slice(2)];
const built = spawnSync('bun', ['x', '@tauri-apps/cli', ...args], { stdio: 'inherit', env });
if (built.status !== 0) process.exit(built.status ?? 1);

const repoRoot = resolve(import.meta.dir, '..');
const releaseDir = join(repoRoot, 'src-tauri', 'target', TARGET, 'release');
const exe = join(releaseDir, 'app.exe');
if (!existsSync(exe)) {
  console.error(`[win-build] built, but ${exe} is missing`);
  process.exit(1);
}

const dist = process.env.BOWERBIRD_WIN_DIST_DIR?.trim();
const outDir = dist == null ? join(releaseDir, 'Bowerbird') : join(resolve(dist), 'Bowerbird');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(exe, join(outDir, 'Bowerbird.exe'));

// The DLLs beside it: Windows resolves imports from the executable's own directory first,
// so this is all the "installation" a dev build needs. Everything MSYS2 unpacked rather
// than the exact closure - a few megabytes against a `dumpbin` walk this box cannot do.
for (const dll of readdirSync(join(mingw, 'bin')).filter((f) => f.endsWith('.dll'))) {
  copyFileSync(join(mingw, 'bin', dll), join(outDir, dll));
}
// And the compiler's own runtime, which the MSYS2 tree does not carry.
const runtime = join(process.env.HOME ?? '', 'local', 'usr', 'lib', 'gcc', 'x86_64-w64-mingw32', '13-posix');
for (const dll of ['libgcc_s_seh-1.dll', 'libstdc++-6.dll']) {
  const found = [join(runtime, dll), join(mingw, 'bin', dll)].find((p) => existsSync(p));
  if (found != null) copyFileSync(found, join(outDir, dll));
}

console.error(`[win-build] app: ${outDir} (unsigned; run Bowerbird.exe)`);

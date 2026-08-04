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
import { ensureIcons } from './make-icons.ts';
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

// The cross toolchain's own bin directory, put on PATH here rather than assumed to be on it
// already. It was assumed: the build worked from a shell whose profile had added it and
// failed from one that had not, with `linker not found` and nothing pointing at why.
const toolchain = process.env.MINGW_BIN ?? join(process.env.HOME ?? '', 'local', 'usr', 'bin');
if (!existsSync(join(toolchain, gcc))) {
  console.error(`[win-build] no ${gcc} in ${toolchain}`);
  console.error('[win-build] set MINGW_BIN, or install the mingw-w64 cross toolchain there');
  process.exit(1);
}

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PATH: `${toolchain}:${process.env.PATH ?? ''}`,
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
ensureIcons();

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

// Empty is unset, not the current directory: `''.trim()` is not null, so `resolve('')` is
// wherever this happens to be running, and the `rmSync` on `outDir` below would take
// `Bowerbird` out of it.
const dist = process.env.BOWERBIRD_WIN_DIST_DIR?.trim();
const outDir = dist ? join(resolve(dist), 'Bowerbird') : join(releaseDir, 'Bowerbird');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(exe, join(outDir, 'Bowerbird.exe'));

// The DLLs beside it: Windows resolves imports from the executable's own directory first,
// so this is all the "installation" a dev build needs.
//
// The binary's actual closure, walked with `objdump`, rather than everything MSYS2
// unpacked - the lazy version shipped seventy DLLs for a handful that are reachable.
// Searched across both the MSYS2 tree and the compiler's own runtime, since `libstdc++`
// and `libgcc` come from the toolchain rather than from a package.
//
// Asked of the compiler rather than spelled out. This was one unpack directory under one
// `$HOME` with a GCC version in it, so on a box whose mingw came from the distro, or whose
// GCC moved off 13, the runtime DLLs were simply not found - and an unfound import was
// taken for a system DLL and dropped, which ships an app that will not start.
function runtimeDirs(): string[] {
  const printed = spawnSync(gcc, ['-print-search-dirs'], { encoding: 'utf8', env });
  const libraries = (printed.stdout ?? '')
    .split('\n')
    .find((line) => line.startsWith('libraries:'));
  return (libraries?.split('=')[1] ?? '')
    .split(':')
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '' && existsSync(dir));
}
/// Where `webview2-com-sys` keeps the loader wry's MinGW build imports by name.
///
/// Not Windows's own, whatever the name suggests: the Evergreen runtime keeps its copy in a
/// versioned directory of its own and nothing puts it on the app's search path. Without it
/// beside the exe the app does not start at all, and this is exactly what the bundle was
/// missing until the walk began reporting what it had assumed away.
function webview2Dirs(): string[] {
  const registry = join(
    process.env.CARGO_HOME ?? join(process.env.HOME ?? '', '.cargo'),
    'registry',
    'src',
  );
  if (!existsSync(registry)) return [];
  const found: string[] = [];
  for (const index of readdirSync(registry)) {
    const dir = join(registry, index);
    for (const crate of readdirSync(dir)) {
      if (!crate.startsWith('webview2-com-sys-')) continue;
      const x64 = join(dir, crate, 'x64');
      if (existsSync(x64)) found.push(x64);
    }
  }
  return found;
}

const search = [join(mingw, 'bin'), ...runtimeDirs(), ...webview2Dirs()];

/** What a PE imports, by name. System DLLs are not in the search path and drop out. */
function imports(file: string): string[] {
  const listed = spawnSync('x86_64-w64-mingw32-objdump', ['-p', file], { encoding: 'utf8', env });
  return (listed.stdout ?? '')
    .split('\n')
    .filter((line) => line.includes('DLL Name:'))
    .map((line) => line.split('DLL Name:')[1]?.trim() ?? '');
}

const shipped: string[] = [];
const assumedSystem: string[] = [];
const queue = imports(exe);
while (queue.length > 0) {
  const dll = queue.shift() ?? '';
  if (dll === '' || shipped.includes(dll)) continue;
  const source = search.map((dir) => join(dir, dll)).find((path) => existsSync(path));
  if (source == null) {
    if (!assumedSystem.includes(dll)) assumedSystem.push(dll);
    continue;
  }
  shipped.push(dll);
  copyFileSync(source, join(outDir, dll));
  queue.push(...imports(source));
}

// An import the search could not place is assumed to be Windows's own, and mostly is. What
// it must never be is a MinGW runtime: `lib*.dll` is that naming and no system DLL uses it,
// so finding one here means the toolchain moved and the bundle is missing a library it
// cannot start without. Silently, until now - the app installs and dies on launch.
const missing = assumedSystem.filter((dll) => /^lib/i.test(dll));
if (missing.length > 0) {
  console.error(`[win-build] not found in ${search.join(', ')}:`);
  for (const dll of missing) console.error(`  ${dll}`);
  process.exit(1);
}
if (assumedSystem.length > 0) {
  console.error(`[win-build] assumed to be Windows's own: ${assumedSystem.join(', ')}`);
}

console.error(`[win-build] app: ${outDir} (unsigned; run Bowerbird.exe)`);

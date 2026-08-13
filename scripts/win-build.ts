// Cross-build the Windows app from Linux, via MinGW. Dev testing only.
//
// `x86_64-pc-windows-gnu`, not `-msvc`. That used to be the whole difficulty: the shell
// takes `rawshim` without `renditions`, which once meant linking LibRaw and its own
// dependencies built for Windows, and for MSVC there was no way to get those on a Linux box
// short of a vcpkg-from-source project. MSYS2's prebuilt MinGW packages solved it. None of
// that applies now - an editor build links no C at all - and the target choice is kept
// because the toolchain is still the one that cross-builds from Linux.
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

// The `-posix` variants: rustc's own std expects POSIX threads on this target.
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

// The MSYS2 tree used to be first here, for LibRaw's own DLLs. Nothing links it now, so what
// is left is the toolchain's runtime and WebView2's loader.
const search = [...runtimeDirs(), ...webview2Dirs()];

/** What a PE imports, by name. System DLLs are not in the search path and drop out. */
function imports(file: string): string[] {
  // `-p` prints the whole private-header dump, which for a 10MB executable is several
  // megabytes and overflows `spawnSync`'s 1MB default. That truncation was already happening
  // and was invisible: the import table lands early enough in the output to survive it, so
  // the right DLLs came out by luck rather than by reading the whole answer.
  const listed = spawnSync('x86_64-w64-mingw32-objdump', ['-p', file], {
    encoding: 'utf8',
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  // Loudly, because the quiet version of this ships. `objdump` missing gives no stdout, which
  // reads as "imports nothing", so the walk below starts with an empty queue, copies no DLLs
  // at all, reports success, and hands over a folder holding one executable that will not
  // start on Windows - and the line about what was assumed to be Windows's own is empty too,
  // so nothing about the output looks wrong.
  if (listed.error != null || listed.status !== 0) {
    const why = listed.error?.message ?? listed.stderr ?? `exit ${String(listed.status)}`;
    throw new Error(`could not read what ${file} imports: ${why}`);
  }
  return listed.stdout
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

// What this binary is expected to find on Windows itself, as observed from the bundle's own
// import closure. Anything else the search could not place is a library the folder needs and
// does not have, which installs and then dies on launch - so it fails the build.
//
// A list of what is Windows's rather than a pattern for what is not. The guard this replaces
// tested `/^lib/i`, on the reasoning that no system DLL is named that way: true, and it
// caught the MinGW runtimes it was written for, but it left `WebView2Loader.dll` and
// `zlib1.dll` outside itself - and the loader is the one import the app cannot start
// without, which is what the walk was added to stop losing in the first place. It only
// happens to be found today because `webview2Dirs()` guesses right about where cargo put the
// crate; a vendored or relocated tree drops it and, under the old test, said nothing.
//
// A name reaching this that really is Windows's belongs on the list. Failing that way round
// is a build that stops and tells somebody, rather than a bundle that ships broken.
const WINDOWS_OWN = [
  'advapi32', 'bcrypt', 'bcryptprimitives', 'comctl32', 'dwmapi', 'gdi32', 'kernel32',
  'msvcrt', 'ntdll', 'ole32', 'oleaut32', 'shell32', 'shlwapi', 'user32', 'ws2_32',
];

// The API sets are Windows's by construction and there are hundreds of them, so those are a
// prefix rather than fifteen more entries.
function windowsOwn(dll: string): boolean {
  const name = dll.toLowerCase().replace(/\.dll$/, '');
  return (
    name.startsWith('api-ms-win-') ||
    name.startsWith('ext-ms-win-') ||
    WINDOWS_OWN.includes(name)
  );
}

const missing = assumedSystem.filter((dll) => !windowsOwn(dll));
if (missing.length > 0) {
  console.error(`[win-build] not found in ${search.join(', ')}:`);
  for (const dll of missing) console.error(`  ${dll}`);
  console.error("[win-build] ship each of these, or add it to WINDOWS_OWN if it is Windows's");
  process.exit(1);
}
if (assumedSystem.length > 0) {
  console.error(`[win-build] assumed to be Windows's own: ${assumedSystem.join(', ')}`);
}

console.error(`[win-build] app: ${outDir} (unsigned; run Bowerbird.exe)`);

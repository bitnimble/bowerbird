// The server the desktop app carries with it (docs/replication.md §13, milestone 4).
//
// **The runtime plus a bundle, not one compiled executable.** `bun build --compile`
// produces a lovely single file that cannot start a worker: the minimal documented
// case fails with `ModuleNotFound resolving /$bunfs/root/<name>.ts` the moment one
// is asked for, and this server reads every RAW header, builds every rendition and
// takes every backup on one. A binary that starts and then cannot read a
// photograph is worse than no binary, so the sidecar is the Bun runtime itself,
// handed a bundle of plain JavaScript beside it.
//
// The native library goes with them as a resource rather than inside anything: it
// is a shared object opened by `dlopen`, and the shell tells the server where it
// landed (`BOWERBIRD_NATIVE_LIB`). lensfun's lens database travels the same way
// (`BOWERBIRD_LENSFUN_DATA`), because lensfun looks for it on compiled-in Unix paths
// and a packaged app is on none of them.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { elfClosure, machClosure, machNames, peClosure } from './native_closure';
import { assertReferenceFrame, REFERENCE_FRAME } from '../src/services/processing/renditions/reference_frame';

const ROOT = join(import.meta.dir, '..');
const BINARIES = join(ROOT, 'src-tauri', 'binaries');
const RESOURCES = join(ROOT, 'src-tauri', 'resources');
const SERVER = join(RESOURCES, 'server');
// The library and everything it needs in one directory, so `$ORIGIN` and `@loader_path` are
// that directory for every object in it and a stale copy cannot outlive a rebuild.
const NATIVE = join(RESOURCES, 'native');
const BESIDE = join(ROOT, 'src-tauri', 'dlls');

const shippedLibrary = (): string => join(NATIVE, libraryName(triple));

/**
 * Every entry point the bundle needs: the server, and each worker it starts.
 *
 * **A worker missing here fails only in the packaged app**, and only when something asks for it:
 * `workerEntry` builds `<dir>/<name>.js` from a directory the shell names, so a file that was
 * never bundled is a `ModuleNotFound` at the moment a reader does the one thing that needs it.
 */
const ENTRIES = [
  join(ROOT, 'src', 'index.ts'),
  join(ROOT, 'src', 'services', 'sync', 'scan', 'scan_worker.ts'),
  join(ROOT, 'src', 'services', 'processing', 'workers', 'processing_worker.ts'),
  join(ROOT, 'src', 'services', 'processing', 'workers', 'prepare_worker.ts'),
  join(ROOT, 'src', 'services', 'maintenance', 'backup_worker.ts'),
];

/**
 * What Rust calls the machine this is for, which is what Tauri looks for on the end
 * of the name. `--target` for a cross build, where it is not this one.
 */
function hostTriple(): string {
  const probe = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error('rustc is not on the path, so the target triple cannot be read');
  const line = probe.stdout.split('\n').find((entry) => entry.startsWith('host: '));
  if (line == null) throw new Error(`rustc did not report a host triple:\n${probe.stdout}`);
  return line.slice('host: '.length).trim();
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * What the shell is built for, which is what Tauri looks for on the end of a sidecar's name.
 *
 * Also what the Bun runtime and the libSQL addon are picked for: Bun is the process that runs
 * the bundle and opens both, so those follow the shell and not `--native-target`.
 */
function targetTriple(): string {
  return flag('target') ?? hostTriple();
}

/**
 * What `rawshim` is built for, which on Windows is not the shell's triple: the server's half
 * links lensfun and the two pinned codecs, and those are MinGW (`release.yml`).
 */
function nativeTriple(): string {
  return flag('native-target') ?? targetTriple();
}

function libraryName(triple: string): string {
  if (triple.includes('apple')) return 'librawshim.dylib';
  if (triple.includes('windows')) return 'rawshim.dll';
  return 'librawshim.so';
}

/**
 * The freshest build of the native library.
 *
 * By modification time and not by a preference between the profiles, which is the one thing
 * that cannot go stale: a `release` left behind by a packaging run otherwise shadows every
 * `bun run build:native` since, and what ships is a library whose ABI predates the bundle
 * beside it - a `Symbol "bb_..." not found` at the first photograph rather than at the build.
 * A release build has one candidate and so no ordering to get wrong.
 */
function nativeLibrary(triple: string): string {
  const name = libraryName(triple);
  // **The root decides before the clock does.** A cross build puts the library under the triple
  // and a native one does not, so mtime across both would let a fresher *host* build win over
  // the cross one asked for - and it is a valid ELF, so the copy, the relocation and the check
  // all pass and the app fails at `dlopen` on the reader's machine.
  const roots = [join(ROOT, 'native', 'rawshim', 'target', triple), join(ROOT, 'native', 'rawshim', 'target')];
  for (const root of roots) {
    const built = ['release', 'quick']
      .map((profile) => join(root, profile, name))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (built[0] != null) return built[0];
  }
  throw new Error(`no ${name} for ${triple} to ship. Run \`bun run build:native\` first.`);
}

/** What libSQL calls the machine, which is not what Rust calls it. */
function libsqlPackage(triple: string): string {
  const named: Record<string, string> = {
    'x86_64-unknown-linux-gnu': 'linux-x64-gnu',
    'x86_64-unknown-linux-musl': 'linux-x64-musl',
    'aarch64-unknown-linux-gnu': 'linux-arm64-gnu',
    'aarch64-unknown-linux-musl': 'linux-arm64-musl',
    'armv7-unknown-linux-gnueabihf': 'linux-arm-gnueabihf',
    'aarch64-apple-darwin': 'darwin-arm64',
    'x86_64-pc-windows-msvc': 'win32-x64-msvc',
  };
  const name = named[triple];
  if (name == null) throw new Error(`no libSQL native package is published for ${triple}`);
  return `@libsql/${name}`;
}

/**
 * The libSQL addon, under a `node_modules` of the bundle's own.
 *
 * `libsql` reaches its `.node` through a bare `require('@libsql/<target>')` evaluated at runtime,
 * which the bundler cannot follow and therefore cannot inline. Beside the bundle is the only place
 * that resolves once the app is installed - and a build run from inside this repo otherwise appears
 * to work, because resolution walks up into the repo's own `node_modules`.
 */
function shipTheAddon(triple: string): void {
  const name = libsqlPackage(triple);
  const from = join(ROOT, 'node_modules', name);
  if (!existsSync(from)) {
    throw new Error(`${name} is not installed, so ${triple} would get a server that cannot open a catalogue. Run \`bun add -d ${name}\`.`);
  }
  cpSync(from, join(SERVER, 'node_modules', name), { recursive: true });
}

/**
 * lensfun's lens database, which nothing else carries.
 *
 * Without it every Canon frame silently falls back to fitting its own geometry, and nothing
 * says so - the library loads, finds no camera, and the fit looks like it simply had nothing
 * to match. So a missing tree fails the build rather than shipping that.
 *
 * `--lensfun-data` names the directory of XML to ship; `pkg-config` otherwise, which gives a
 * `share` and leaves the versioned directory under it to find. The version is not written
 * down here: the copy is flat and `BOWERBIRD_LENSFUN_DATA` names where it landed.
 */
function shipTheLensDatabase(): void {
  const named = flag('lensfun-data');
  const from = named ?? versionedLensfunData();
  cpSync(from, join(RESOURCES, 'lensfun'), { recursive: true });
  console.log(`lensfun: ${join(RESOURCES, 'lensfun')} (from ${from})`);
}

function versionedLensfunData(): string {
  const asked = spawnSync('pkg-config', ['--variable=datadir', 'lensfun'], { encoding: 'utf8' });
  const datadir = asked.status === 0 ? asked.stdout.trim() : '';
  if (datadir === '') {
    throw new Error('pkg-config cannot find lensfun, so its lens database cannot be shipped. Install it, or pass --lensfun-data.');
  }
  // Joined as a string rather than through `join`: on Windows that would turn `/clang64/share`
  // into a backslashed path, which `cygpath -w` reads as already converted and hands back.
  const root = hostPath(`${datadir}/lensfun`);
  const versions = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && readdirSync(join(root, entry.name)).some((file) => file.endsWith('.xml')))
        .map((entry) => entry.name)
    : [];
  if (versions.length !== 1) {
    throw new Error(`${root} holds ${versions.length} directories of lens XML where exactly one is expected. Pass --lensfun-data.`);
  }
  return join(root, versions[0]!);
}

/** Every shared library `rawshim` needs, carried by the app rather than found (DESIGN §23.7.1). */
function shipTheClosure(triple: string, library: string): void {
  // Each arm drives the target's own loader tools, which only the target has: a macOS closure
  // assembled from Linux would reach for `otool` and fail as a missing command rather than as
  // the cross build it is.
  const platform = triple.includes('windows') ? 'win32' : triple.includes('apple') ? 'darwin' : 'linux';
  if (platform !== process.platform) {
    throw new Error(`the libraries ${triple} needs can only be gathered on ${triple}: assemble that app there`);
  }
  if (triple.includes('windows')) return besideTheExecutables(library);
  if (triple.includes('apple')) return underLoaderPath();
  underOrigin();
}

/**
 * Windows, where nothing is rewritten because a PE names its imports by filename alone.
 *
 * **Two copies, and that is not belt and braces.** A dependent DLL resolves out of the loading
 * process's directory, which is `bowerbird-server.exe`'s - unless `LoadLibraryEx` was passed
 * `LOAD_WITH_ALTERED_SEARCH_PATH`, what libuv's `dlopen` uses, which searches the loaded
 * library's own directory and drops the process's from the order entirely. Which one `bun:ffi`
 * gets is not observable from here, and a copy in both places is correct under either.
 */
function besideTheExecutables(library: string): void {
  const prefix = process.env.MSYSTEM_PREFIX;
  if (prefix == null) {
    throw new Error('a MinGW rawshim.dll has to be gathered inside an MSYS2 shell, which is what sets MSYSTEM_PREFIX');
  }
  const needed = peClosure(walk('ldd', shippedLibrary()), prefix);
  if (needed.length === 0) throw new Error(`${library} needs nothing from ${prefix}, which no lensfun build does`);
  mkdirSync(BESIDE, { recursive: true });
  for (const path of needed) {
    carry(hostPath(path), BESIDE);
    carry(hostPath(path), NATIVE);
  }
  console.log(`beside:  ${BESIDE} and ${NATIVE} (${needed.length} DLLs from ${prefix})`);
}

/**
 * Linux, where an ELF carries its own search path.
 *
 * `$ORIGIN` is the directory of the object that names it, and a search path does not reach a
 * dependency's own dependencies - so every copy gets one, not just the library the server opens.
 */
function underOrigin(): void {
  const shipped = elfClosure(walk('ldd', shippedLibrary())).map((path) => carry(path, NATIVE));
  const relocated = [shippedLibrary(), ...shipped];
  for (const at of relocated) {
    // `DT_RPATH` and not the `DT_RUNPATH` patchelf writes by default: the loader consults a
    // runpath *after* `LD_LIBRARY_PATH`, so an app launched from a shell that names an older
    // glib or libstdc++ - conda, Steam, a `~/.local/lib` - would get that one instead of the
    // copy beside it, which is the failure this carrying exists to prevent.
    run('patchelf', ['--force-rpath', '--set-rpath', '$ORIGIN', at]);
  }
  for (const at of relocated) refuseStrangers(at, elfClosure(walk('ldd', at)));
  console.log(`closure: ${NATIVE} (${shipped.length} libraries, rpath $ORIGIN)`);
}

/**
 * macOS, where a Mach-O names each dependency by the path it was linked at.
 *
 * Re-signed after the last edit, because editing a load command invalidates the signature and
 * Apple silicon will not map a library whose signature does not hold.
 */
function underLoaderPath(): void {
  const carried = new Map<string, string>();
  const pending = [shippedLibrary()];
  while (pending.length > 0) {
    const at = pending.pop()!;
    for (const dependency of machClosure(walk('otool', at, '-L'), basename(at))) {
      if (carried.has(dependency)) continue;
      // One directory, so a filename is the whole name: two libraries sharing one would
      // overwrite each other and both be rewritten to the survivor, which is a missing symbol
      // at first use rather than anything the checks below could see.
      const clash = [...carried].find(([, name]) => name === basename(dependency));
      if (clash != null) throw new Error(`${dependency} and ${clash[0]} share a filename`);
      carried.set(dependency, basename(dependency));
      pending.push(carry(dependency, NATIVE));
    }
  }
  const shipped = [...carried.values()].map((name) => join(NATIVE, name));
  for (const at of shipped) run('install_name_tool', ['-id', `@loader_path/${basename(at)}`, at]);
  const relocated = [shippedLibrary(), ...shipped];
  for (const at of relocated) {
    for (const [was, name] of carried) run('install_name_tool', ['-change', was, `@loader_path/${name}`, at]);
    run('codesign', ['--force', '--sign', '-', at]);
  }
  for (const at of relocated) refuseStrangers(at, machNames(walk('otool', at, '-L'), basename(at)));
  console.log(`closure: ${NATIVE} (${carried.size} libraries, @loader_path)`);
}

/**
 * Nothing the app opens may come from outside the tree it carries.
 *
 * The outcome rather than each way of getting it wrong: a dependency named through an `@rpath`
 * the library already had is one this cannot carry and Homebrew is free to leave. `@loader_path`
 * is what this script wrote, and so the one relative name that passes.
 */
function refuseStrangers(library: string, named: string[]): void {
  const strangers = named.filter((path) => !path.startsWith(`${NATIVE}/`) && !path.startsWith('@loader_path/'));
  if (strangers.length > 0) {
    throw new Error(`${library} still reaches outside what this app carries: ${strangers.join(', ')}`);
  }
}

/** What a loader says one library needs, refused rather than shrugged off. */
function walk(tool: string, library: string, ...before: string[]): string {
  const walked = spawnSync(tool, [...before, library], { encoding: 'utf8' });
  if (walked.status !== 0) {
    throw new Error(`${tool} could not read what ${library} needs: ${walked.error?.message ?? walked.stderr ?? `exit ${String(walked.status)}`}`);
  }
  return walked.stdout;
}

/**
 * One library into the tree that ships, writable.
 *
 * A distribution's copy is read-only, and both `patchelf` and `install_name_tool` edit in place.
 */
function carry(from: string, into: string): string {
  const at = join(into, basename(from));
  copyFileSync(from, at);
  chmodSync(at, 0o755);
  return at;
}

/**
 * An MSYS2 path as the Windows processes here can open it.
 *
 * `ldd` and `pkg-config` answer in `/clang64/...`, which only the MSYS2 layer understands;
 * bun, cargo and Tauri are native Windows and see nothing there. A pass-through everywhere
 * else, where the two are the same thing.
 */
function hostPath(path: string): string {
  if (process.env.MSYSTEM_PREFIX == null) return path;
  const converted = spawnSync('cygpath', ['-w', path], { encoding: 'utf8' });
  if (converted.status !== 0) throw new Error(`cygpath could not place ${path}: ${converted.stderr ?? ''}`);
  return converted.stdout.trim();
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const triple = targetTriple();
const native = nativeTriple();
const suffix = triple.includes('windows') ? '.exe' : '';
mkdirSync(BINARIES, { recursive: true });
// **Emptied, not written over.** Everything under here is written by this script, and every
// part of it is copied in whole rather than file by file - a bundle, a lens database, a
// library and its closure. So anything left from a previous run is something an installed app
// would carry twice, and a path this script no longer writes is one nothing would ever remove.
rmSync(RESOURCES, { recursive: true, force: true });
rmSync(BESIDE, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });
mkdirSync(NATIVE, { recursive: true });

// `@parcel/watcher` is left out deliberately: it is a native addon that cannot be
// bundled, and the server is built to be told no and fall back (`watch_backend.ts`).
// Flat, so a worker is `<dir>/<name>.js` and nothing has to know which folder it
// came from; `workerEntry` builds exactly that path.
run('bun', [
  'build',
  '--target',
  'bun',
  '--outdir',
  SERVER,
  '--entry-naming',
  '[name].[ext]',
  '--external',
  '@parcel/watcher',
  ...ENTRIES,
]);

// The generated migrations, which the bundler does not see: they are read at runtime rather than
// imported, so nothing links them. `runMigrations` looks beside itself for them, and the bundle is
// flat, so beside itself is the bundle root - which is what makes the same path work in both
// layouts. Without this the desktop server starts, finds no migrations folder and cannot open a
// catalogue at all.
cpSync(join(ROOT, 'src', 'db', 'migrations'), join(SERVER, 'migrations'), { recursive: true });
shipTheAddon(triple);

// The runtime, named as Tauri expects a sidecar to be. Copied rather than
// referenced so the app depends on nothing the machine happens to have.
//
// **Cross-building needs one of the target's own**, since this is an executable
// and not something the bundler produced: `BOWERBIRD_SIDECAR_RUNTIME` is where a
// macOS `bun` goes when the `.app` is being assembled from Linux. Refused rather
// than guessed at, because the wrong one produces an app that opens and finds no
// library, which looks like a bug in the app rather than a missing step here.
const host = hostTriple();
const runtime = process.env.BOWERBIRD_SIDECAR_RUNTIME ?? process.execPath;
if (process.env.BOWERBIRD_SIDECAR_RUNTIME == null && triple !== host) {
  throw new Error(`building for ${triple} from ${host}: set BOWERBIRD_SIDECAR_RUNTIME to a bun built for ${triple}`);
}
const sidecar = join(BINARIES, `bowerbird-server-${triple}${suffix}`);
// Unlinked rather than overwritten: a copy of this one still running - a desktop
// app left open, a probe that outlived its check - holds the file and the write
// fails with ETXTBSY. Removing the name first leaves that process with its own
// inode and this build with a clean one.
rmSync(sidecar, { force: true });
copyFileSync(runtime, sidecar);
chmodSync(sidecar, 0o755);

const library = nativeLibrary(native);
copyFileSync(library, shippedLibrary());
// Writable, because the relocation below edits it in place.
chmodSync(shippedLibrary(), 0o755);
shipTheClosure(native, library);

const frame = join(ROOT, 'assets', REFERENCE_FRAME.filename);
assertReferenceFrame(frame);
copyFileSync(frame, join(RESOURCES, REFERENCE_FRAME.filename));

shipTheLensDatabase();

console.log(`sidecar: ${sidecar} (the Bun runtime, from ${runtime})`);
console.log(`server:  ${join(SERVER, 'index.js')}`);
console.log(`native:  ${shippedLibrary()} (from ${library})`);
console.log(`frame:   ${join(RESOURCES, REFERENCE_FRAME.filename)}`);
console.log(`schema:  ${join(SERVER, 'migrations')}`);
console.log(`libsql:  ${join(SERVER, 'node_modules', libsqlPackage(triple))}`);

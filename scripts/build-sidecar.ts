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
// landed (`BOWERBIRD_NATIVE_LIB`).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ANDROID_ABI, ANDROID_TARGET, androidNdk } from './android-ndk';
import {
  LIBSQL as ANDROID_LIBSQL,
  RUNTIME as ANDROID_RUNTIME,
  WATCHER as ANDROID_WATCHER,
} from './get-android-runtime';
import { hostTriple } from './host-triple.ts';
import { ensureIcons } from './make-icons.ts';
import { elfClosure, machNames } from './native_closure';
import { pinnedLink } from './pinned';

const ROOT = join(import.meta.dir, '..');
const BINARIES = join(ROOT, 'src-tauri', 'binaries');
const RESOURCES = join(ROOT, 'src-tauri', 'resources');
const SERVER = join(RESOURCES, 'server');
// The library and everything it needs in one directory, so `$ORIGIN` and `@loader_path` are
// that directory for every object in it and a stale copy cannot outlive a rebuild.
const NATIVE = join(RESOURCES, 'native');

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
  join(ROOT, 'src', 'services', 'processing', 'rawshim', 'rawshim_command_worker.ts'),
  join(ROOT, 'src', 'services', 'printing', 'printshim_worker.ts'),
  join(ROOT, 'src', 'services', 'maintenance', 'backup_worker.ts'),
];

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * What everything here is built for: the shell Tauri looks for on the end of a sidecar's name,
 * the Bun runtime and the native addons that run beside it, and `rawshim` itself.
 */
function targetTriple(): string {
  return flag('target') ?? hostTriple();
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
  // **A cross build is only ever looked for under its triple.** A native one lands in either
  // root (`build:native` without `--target`, `build:app` with it), so both are this machine's and
  // the clock decides between them; for any other triple the bare root is a *host* build, a valid
  // ELF that passes the copy, the relocation and the check and fails at `dlopen` on the reader's
  // machine.
  const roots = [join(ROOT, 'native', 'rawshim', 'target', triple)];
  if (triple === hostTriple()) roots.push(join(ROOT, 'native', 'rawshim', 'target'));
  const built = roots
    .flatMap((root) => ['release', 'quick'].map((profile) => join(root, profile, name)))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (built[0] != null) return built[0];
  throw new Error(`no ${name} for ${triple} to ship. Run \`bun run build:native\` first.`);
}

function nativePackages(triple: string): readonly [string, string] {
  const named: Record<string, readonly [string, string]> = {
    'x86_64-unknown-linux-gnu': ['@libsql/linux-x64-gnu', '@parcel/watcher-linux-x64-glibc'],
    'x86_64-unknown-linux-musl': ['@libsql/linux-x64-musl', '@parcel/watcher-linux-x64-musl'],
    'aarch64-unknown-linux-gnu': ['@libsql/linux-arm64-gnu', '@parcel/watcher-linux-arm64-glibc'],
    'aarch64-unknown-linux-musl': ['@libsql/linux-arm64-musl', '@parcel/watcher-linux-arm64-musl'],
    'armv7-unknown-linux-gnueabihf': [
      '@libsql/linux-arm-gnueabihf',
      '@parcel/watcher-linux-arm-glibc',
    ],
    'aarch64-apple-darwin': ['@libsql/darwin-arm64', '@parcel/watcher-darwin-arm64'],
    'x86_64-pc-windows-msvc': ['@libsql/win32-x64-msvc', '@parcel/watcher-win32-x64'],
  };
  const names = named[triple];
  if (names == null) throw new Error(`no native addon packages are configured for ${triple}`);
  return names;
}

function shipTheAddons(triple: string): void {
  for (const name of nativePackages(triple)) {
    const from = join(ROOT, 'node_modules', name);
    if (!existsSync(from)) {
      throw new Error(
        `${name} is not installed, so ${triple} cannot ship its server. Install the target's native addon packages first.`,
      );
    }
    cpSync(from, join(SERVER, 'node_modules', name), { recursive: true, dereference: true });
  }
}

/**
 * Every shared library the native modules need, carried by the app rather than found (DESIGN §23.7.1).
 *
 * The codecs are static everywhere (`get-codecs.ts`), so on Windows and macOS there is nothing to
 * carry: the C and C++ runtimes are the OS's own. Linux's are not - a distribution's libstdc++ is
 * whatever that distribution shipped - so they travel with the app.
 */
function shipTheClosure(triple: string): void {
  if (triple.includes('windows')) return;
  const libraries = [
    shippedLibrary(),
    join(SERVER, 'node_modules', nativePackages(triple)[1], 'watcher.node'),
  ];
  // Each arm drives the target's own loader tools: `otool` reads a Mach-O on any machine that has
  // one (LLVM's `llvm-otool` under that name), where `ldd` only reads what this machine can load.
  if (triple.includes('apple')) {
    if (spawnSync('sh', ['-c', 'command -v otool']).status !== 0) {
      throw new Error(
        `the libraries ${triple} needs are read with otool, which is not on the path`,
      );
    }
    return askNothingOfMacos(libraries);
  }
  if (process.platform !== 'linux') {
    throw new Error(
      `the libraries ${triple} needs can only be read on ${triple}: assemble that app there`,
    );
  }
  underOrigin(libraries);
}

/**
 * Linux, where an ELF carries its own search path.
 *
 * `$ORIGIN` is the directory of the object that names it, and a search path does not reach a
 * dependency's own dependencies - so every copy gets one, not just the library the server opens.
 */
function underOrigin(libraries: string[]): void {
  const needed = new Set(libraries.flatMap((library) => elfClosure(walk('ldd', library))));
  const shipped = [...needed].map((path) => carry(path, NATIVE));
  const relocated = [...libraries, ...shipped];
  for (const at of relocated) {
    // `DT_RPATH` and not the `DT_RUNPATH` patchelf writes by default: the loader consults a
    // runpath *after* `LD_LIBRARY_PATH`, so an app launched from a shell that names an older
    // libstdc++ - conda, Steam, a `~/.local/lib` - would get that one instead of the copy beside
    // it, which is the failure this carrying exists to prevent.
    const directory = relative(dirname(at), NATIVE);
    run('patchelf', [
      '--force-rpath',
      '--set-rpath',
      directory === '' ? '$ORIGIN' : `$ORIGIN/${directory}`,
      at,
    ]);
  }
  for (const at of relocated) refuseStrangers(at, elfClosure(walk('ldd', at)));
  console.log(`closure: ${NATIVE} (${shipped.length} libraries, rpath $ORIGIN)`);
}

/**
 * macOS, where native modules should ask for nothing but Apple's own libraries, and are refused if they
 * do: a Homebrew library named here links on the build machine and fails to load on a reader's.
 */
function askNothingOfMacos(libraries: string[]): void {
  for (const library of libraries) {
    const foreign = machNames(walk('otool', library, '-L'), basename(library));
    if (foreign.length > 0) {
      throw new Error(
        `${library} needs ${foreign.join(', ')}, which no reader's Mac has: link it statically`,
      );
    }
    console.log(`closure: ${library} needs nothing but macOS`);
  }
}

/** Nothing the app opens may come from outside the tree it carries. */
function refuseStrangers(library: string, named: string[]): void {
  const strangers = named.filter((path) => !resolve(path).startsWith(`${NATIVE}/`));
  if (strangers.length > 0) {
    throw new Error(
      `${library} still reaches outside what this app carries: ${strangers.join(', ')}`,
    );
  }
}

/** What a loader says one library needs, refused rather than shrugged off. */
function walk(tool: string, library: string, ...before: string[]): string {
  const walked = spawnSync(tool, [...before, library], { encoding: 'utf8' });
  if (walked.status !== 0) {
    throw new Error(
      `${tool} could not read what ${library} needs: ${walked.error?.message ?? walked.stderr ?? `exit ${String(walked.status)}`}`,
    );
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
 * The runtime under Bowerbird's name and icon, which is what Task Manager shows for it.
 *
 * Bun writes those only into a compiled executable, and only when compiling on Windows, so this
 * is a compiled stub that the shell runs as plain Bun (`BUN_BE_BUN` in `server.rs`).
 */
function nameTheWindowsRuntime(runtime: string, to: string): void {
  ensureIcons();
  run('bun', [
    'build',
    '--compile',
    `--compile-executable-path=${runtime}`,
    `--windows-icon=${join(ROOT, 'src-tauri', 'icons', 'icon.ico')}`,
    '--windows-title=Bowerbird',
    '--windows-description=Bowerbird',
    `--outfile=${to}`,
    join(ROOT, 'scripts', 'sidecar_stub.ts'),
  ]);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Android maps code only from the native library directory its package installer fills from
 * `jniLibs`, so everything executable goes there under a library's name, and the bundle loads each
 * addon from there (`BOWERBIRD_ADDON_DIR`, which `android.rs` sets) rather than from beside itself.
 * The bundle and the page are the app's assets, which `android.rs` unpacks.
 */
function shipForAndroid(): void {
  const runtime = pinnedLink('android-runtime');
  if (!existsSync(join(runtime, ANDROID_RUNTIME))) {
    throw new Error(`no Android runtime at ${runtime}. Run \`bun run get:android-runtime\` first.`);
  }
  const main = join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
  if (!existsSync(main)) {
    throw new Error(`no Android project at ${main}. \`android-build.ts\` makes one.`);
  }
  const jni = join(main, 'jniLibs', ANDROID_ABI);
  // Emptied for the reason `RESOURCES` is; Tauri's Gradle plugin writes its own library back in.
  rmSync(jni, { recursive: true, force: true });
  mkdirSync(jni, { recursive: true });
  const ndk = androidNdk();
  const shipped = [
    ...[ANDROID_RUNTIME, ANDROID_LIBSQL, ANDROID_WATCHER].map((name) =>
      carry(join(runtime, name), jni),
    ),
    carry(nativeLibrary(triple), jni),
    // Parcel's Android watcher is built against the shared libc++, which no phone has of its own.
    carry(join(ndk.sysroot, 'usr', 'lib', ANDROID_TARGET, 'libc++_shared.so'), jni),
  ];

  for (const [addon, library] of [
    ['@libsql/android-arm64', ANDROID_LIBSQL],
    ['@parcel/watcher-android-arm64', ANDROID_WATCHER],
  ] as const) {
    const at = join(SERVER, 'node_modules', addon);
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, 'package.json'),
      `${JSON.stringify({ name: addon, main: 'index.js' })}\n`,
    );
    writeFileSync(
      join(at, 'index.js'),
      [
        "const { join } = require('node:path');",
        'const addon = { exports: {} };',
        `process.dlopen(addon, join(process.env.BOWERBIRD_ADDON_DIR, '${library}'));`,
        'module.exports = addon.exports;',
        '',
      ].join('\n'),
    );
  }
  cpSync(join(ROOT, 'web', 'dist'), join(RESOURCES, 'web'), { recursive: true });
  // What `android.rs` keys its unpacked copy on, so a phone does not hash the payload every launch.
  writeFileSync(join(RESOURCES, ANDROID_PAYLOAD_ID), `${payloadId(RESOURCES)}\n`);

  const carried = new Set(shipped.map((library) => basename(library)));
  const readelf = join(ndk.bin, 'llvm-readelf');
  for (const library of shipped) {
    const needed = [
      ...walk(readelf, library, '-d').matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g),
    ]
      .map((match) => match[1]!)
      .filter((name) => !ANDROID_SYSTEM_LIBRARIES.has(name) && !carried.has(name));
    if (needed.length > 0) {
      throw new Error(
        `${library} needs ${needed.join(', ')}, which Android does not provide: link it statically`,
      );
    }
  }
  for (const library of shipped) console.log(`jniLibs: ${library}`);
}

const ANDROID_PAYLOAD_ID = 'payload-id';

function payloadId(root: string): string {
  const hash = createHash('sha256');
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** What every Android device has, from the NDK's stable system libraries. */
const ANDROID_SYSTEM_LIBRARIES = new Set([
  'libc.so',
  'libm.so',
  'libdl.so',
  'liblog.so',
  'libandroid.so',
  'libvulkan.so',
  'libz.so',
]);

const triple = targetTriple();
// **Emptied, not written over.** Everything under here is written by this script, and every
// part of it is copied in whole rather than file by file - a bundle, a library and its closure.
// So anything left from a previous run is something an installed app would carry twice, and a
// path this script no longer writes is one nothing would ever remove.
rmSync(RESOURCES, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });

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
  '--splitting',
  '--external',
  '*.node',
  '--external',
  'samsung-frame-art',
  ...ENTRIES,
]);

// The generated migrations, which the bundler does not see: they are read at runtime rather than
// imported, so nothing links them. `runMigrations` looks beside itself for them, and the bundle is
// flat, so beside itself is the bundle root - which is what makes the same path work in both
// layouts. Without this the desktop server starts, finds no migrations folder and cannot open a
// catalogue at all.
cpSync(join(ROOT, 'src', 'db', 'migrations'), join(SERVER, 'migrations'), { recursive: true });
// LGPL: shipped as its own module rather than bundled, so a recipient can replace it (THIRD_PARTY.md).
cpSync(
  join(ROOT, 'node_modules', 'samsung-frame-art'),
  join(SERVER, 'node_modules', 'samsung-frame-art'),
  {
    recursive: true,
    dereference: true,
  },
);
if (triple === ANDROID_TARGET) shipForAndroid();
else shipForDesktop();
console.log(`server:  ${join(SERVER, 'index.js')}`);
console.log(`schema:  ${join(SERVER, 'migrations')}`);

function shipForDesktop(): void {
  shipTheAddons(triple);
  mkdirSync(BINARIES, { recursive: true });
  mkdirSync(NATIVE, { recursive: true });

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
    throw new Error(
      `building for ${triple} from ${host}: set BOWERBIRD_SIDECAR_RUNTIME to a bun built for ${triple}`,
    );
  }
  const suffix = triple.includes('windows') ? '.exe' : '';
  const sidecar = join(BINARIES, `bowerbird-server-${triple}${suffix}`);
  // Unlinked rather than overwritten: a copy of this one still running - a desktop
  // app left open, a probe that outlived its check - holds the file and the write
  // fails with ETXTBSY. Removing the name first leaves that process with its own
  // inode and this build with a clean one.
  rmSync(sidecar, { force: true });
  // `release:check`'s cross-build from Linux cannot name it, and ships Bun's own name and icon.
  if (triple.includes('windows') && process.platform === 'win32') {
    nameTheWindowsRuntime(runtime, sidecar);
  } else {
    copyFileSync(runtime, sidecar);
  }
  chmodSync(sidecar, 0o755);

  const library = nativeLibrary(triple);
  copyFileSync(library, shippedLibrary());
  // Writable, because the relocation below edits it in place.
  chmodSync(shippedLibrary(), 0o755);
  shipTheClosure(triple);

  console.log(`sidecar: ${sidecar} (the Bun runtime, from ${runtime})`);
  console.log(`native:  ${shippedLibrary()} (from ${library})`);
  for (const name of nativePackages(triple))
    console.log(`addon:   ${join(SERVER, 'node_modules', name)}`);
}

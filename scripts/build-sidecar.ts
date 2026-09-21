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
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertReferenceFrame, REFERENCE_FRAME } from '../src/services/processing/renditions/reference_frame';

const ROOT = join(import.meta.dir, '..');
const BINARIES = join(ROOT, 'src-tauri', 'binaries');
const RESOURCES = join(ROOT, 'src-tauri', 'resources');
const SERVER = join(RESOURCES, 'server');

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

function targetTriple(): string {
  const named = process.argv.indexOf('--target');
  if (named !== -1 && process.argv[named + 1] != null) return process.argv[named + 1]!;
  return hostTriple();
}

function libraryName(triple: string): string {
  if (triple.includes('apple')) return 'librawshim.dylib';
  if (triple.includes('windows')) return 'rawshim.dll';
  return 'librawshim.so';
}

/** The freshest build of the native library, preferring what `build:native` writes. */
function nativeLibrary(triple: string): string {
  const name = libraryName(triple);
  // A cross build puts it under the triple; a native one does not.
  const roots = [join(ROOT, 'native', 'rawshim', 'target', triple), join(ROOT, 'native', 'rawshim', 'target')];
  for (const root of roots) {
    for (const profile of ['release', 'quick']) {
      const candidate = join(root, profile, name);
      if (existsSync(candidate)) return candidate;
    }
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
    'x86_64-apple-darwin': 'darwin-x64',
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

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const triple = targetTriple();
const suffix = triple.includes('windows') ? '.exe' : '';
mkdirSync(BINARIES, { recursive: true });
rmSync(SERVER, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });

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

// The runtime, named as Tauri expects a sidecar to be. Copied rather than
// referenced so the app depends on nothing the machine happens to have.
//
// **Cross-building needs one of the target's own**, since this is an executable
// and not something the bundler produced: `BOWERBIRD_SIDECAR_RUNTIME` is where a
// macOS `bun` goes when the `.app` is being assembled from Linux. Refused rather
// than guessed at, because the wrong one produces an app that opens and finds no
// library, which looks like a bug in the app rather than a missing step here.
// The generated migrations, which the bundler does not see: they are read at runtime rather than
// imported, so nothing links them. `runMigrations` looks beside itself for them, and the bundle is
// flat, so beside itself is the bundle root - which is what makes the same path work in both
// layouts. Without this the desktop server starts, finds no migrations folder and cannot open a
// catalogue at all.
cpSync(join(ROOT, 'src', 'db', 'migrations'), join(SERVER, 'migrations'), { recursive: true });
shipTheAddon(triple);

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

const library = nativeLibrary(triple);
copyFileSync(library, join(RESOURCES, libraryName(triple)));

const frame = join(ROOT, 'assets', REFERENCE_FRAME.filename);
assertReferenceFrame(frame);
copyFileSync(frame, join(RESOURCES, REFERENCE_FRAME.filename));

console.log(`sidecar: ${sidecar} (the Bun runtime, from ${runtime})`);
console.log(`server:  ${join(SERVER, 'index.js')}`);
console.log(`native:  ${join(RESOURCES, libraryName(triple))} (from ${library})`);
console.log(`frame:   ${join(RESOURCES, REFERENCE_FRAME.filename)}`);
console.log(`schema:  ${join(SERVER, 'migrations')}`);
console.log(`libsql:  ${join(SERVER, 'node_modules', libsqlPackage(triple))}`);

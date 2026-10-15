// Builds the pinned libvpx for `wasm32-wasip1-threads` into the user's cache, which
// `native/rawshim/.vpx/` then points at (`pinned.ts` says why it is not in the checkout).
//
//   bun run get:vpx
//
// The editor's VP9 encoder on Firefox (`native/vp9_encode`) links it. The tree holds libvpx's
// headers and archive, and the part of the WASI sysroot both were compiled against, which the
// crate's bindings and link read.
//
// Linux and macOS hosts only: libvpx's build is a shell `configure` and `make`. CI builds the
// browser's package on Linux and every other job downloads it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  alreadyPinned,
  fetchPinned,
  linkPinned,
  makeOnce,
  pin,
  pinnedHome,
  unpack,
} from './pinned';

const NAME = 'vpx';
const WASI_SDK = '34';
const WASI_SDK_HASHES: Record<string, string> = {
  'x86_64-linux': 'b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4',
  'arm64-linux': 'f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971',
  'x86_64-macos': '87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb',
  'arm64-macos': '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9',
};
const LIBVPX = 'https://chromium.googlesource.com/webm/libvpx';
const LIBVPX_TAG = 'v1.17.0';
const LIBVPX_COMMIT = '6df3ec34557879fff673706f4a1d9fbd0f3a6f0e';
const TARGET = 'wasm32-wasip1-threads';
// `-wasm-enable-sjlj`: libvpx reports an encoder's errors by `longjmp`, which WASI has only through
// wasm exception handling.
const CFLAGS = ['-O3', '-msimd128', '-pthread', '-mllvm', '-wasm-enable-sjlj'];
const CONFIGURE = [
  '--target=generic-gnu',
  '--enable-vp9-highbitdepth',
  '--enable-multithread',
  '--disable-vp8',
  '--disable-vp9-decoder',
  '--disable-examples',
  '--disable-tools',
  '--disable-docs',
  '--disable-unit-tests',
  '--disable-runtime-cpu-detect',
  '--enable-static',
  '--disable-shared',
];

const HOST = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-${process.platform === 'darwin' ? 'macos' : 'linux'}`;
const RECIPE = pin(`libvpx ${LIBVPX_TAG} ${LIBVPX_COMMIT}, wasi-sdk ${WASI_SDK}`, [
  ...CFLAGS,
  ...CONFIGURE,
  createHash('sha256')
    .update(readFileSync(import.meta.path))
    .digest('hex'),
]);
const HOME = pinnedHome(NAME, RECIPE);

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const done = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
}

async function fetchWasiSdk(scratch: string): Promise<string> {
  const sha256 = WASI_SDK_HASHES[HOST];
  if (process.platform === 'win32' || sha256 == null)
    throw new Error(
      `get:vpx builds on Linux or macOS, and this is ${process.platform}-${process.arch}`,
    );
  const name = `wasi-sdk-${WASI_SDK}.0-${HOST}.tar.gz`;
  const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK}/${name}`;
  const bytes = new Uint8Array(await (await fetchPinned(url)).arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${name} hashes ${got}, not the pinned ${sha256}`);
  writeFileSync(resolve(scratch, name), bytes);
  unpack(scratch, name);
  return resolve(scratch, `wasi-sdk-${WASI_SDK}.0-${HOST}`);
}

function fetchLibvpx(scratch: string): string {
  const source = resolve(scratch, 'libvpx');
  run('git', ['init', '--quiet', source], scratch);
  run('git', ['fetch', '--quiet', '--depth=1', LIBVPX, LIBVPX_COMMIT], source);
  run('git', ['checkout', '--quiet', 'FETCH_HEAD'], source);
  return source;
}

function build(sdk: string, source: string): void {
  const sysroot = resolve(sdk, 'share/wasi-sysroot');
  const flags = [`--target=${TARGET}`, `--sysroot=${sysroot}`, ...CFLAGS].join(' ');
  const tool = (name: string): string => resolve(sdk, 'bin', name);
  const env = {
    ...process.env,
    CC: tool('clang'),
    CXX: tool('clang++'),
    LD: tool('clang'),
    AR: tool('llvm-ar'),
    NM: tool('llvm-nm'),
    RANLIB: tool('llvm-ranlib'),
    STRIP: tool('llvm-strip'),
    CFLAGS: flags,
    CXXFLAGS: flags,
    LDFLAGS: `${flags} -lsetjmp`,
  };
  const objects = resolve(HOME, 'build');
  mkdirSync(objects);
  run(resolve(source, 'configure'), [...CONFIGURE, `--prefix=${HOME}`], objects, env);
  run('make', [`-j${cpus().length}`], objects, env);
  run('make', ['install'], objects, env);
  rmSync(objects, { recursive: true, force: true });
  for (const part of ['include', 'lib'])
    cpSync(resolve(sysroot, part, TARGET), resolve(HOME, 'sysroot', part, TARGET), {
      recursive: true,
    });
  // The compiler's own headers (`stddef.h`, `stdint.h`), which bindgen's libclang has none of for
  // this target.
  const [clang] = readdirSync(resolve(sdk, 'lib/clang'));
  if (clang == null) throw new Error(`${sdk} has no clang resource directory`);
  cpSync(resolve(sdk, 'lib/clang', clang, 'include'), resolve(HOME, 'clang-include'), {
    recursive: true,
  });
}

async function main(): Promise<void> {
  const rebuild = process.env.BOWERBIRD_REBUILD_VPX != null;
  if (!alreadyPinned(HOME, RECIPE) || rebuild) {
    const scratch = mkdtempSync(join(tmpdir(), 'bb-vpx-'));
    try {
      const sdk = await fetchWasiSdk(scratch);
      const source = fetchLibvpx(scratch);
      makeOnce(HOME, RECIPE, rebuild, () => build(sdk, source));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  linkPinned(NAME, HOME);
  console.log(`libvpx ${LIBVPX_TAG} for ${TARGET} at ${HOME}`);
}

await main();

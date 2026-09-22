// Builds the pinned libjxl into the user's cache, which `native/rawshim/.libjxl/` then points at
// (`pinned.ts` says why it is not in the checkout).
//
//   bun run get:libjxl
//
// `build.rs` refuses with this command's name when it finds nothing here, for `get-libavif.ts`'s
// reason: a silent fall-back is a format quietly absent from a build that looks complete.
//
// **Why not the distribution's.** Debian bookworm and Ubuntu 24.04 ship 0.7, which predates the
// encoder settling: 0.10 is where the API stopped moving and where the encoder's own defaults
// changed enough that the same request produces a visibly different file. An export is the one
// path a reader keeps the bytes of, so which machine wrote them must not be visible in them.
//
// **The dependencies are the system's, for the reason libavif's codecs are.** highway, brotli and
// lcms2 are all installed and all stable; vendoring copies here would build three more libraries
// to no end.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CMAKE_CONFIG,
  installedVersion,
  linkPinned,
  makeOnce,
  pin,
  pinnedHome,
  unpack,
} from './pinned';

const NAME = 'libjxl';
const VERSION = '0.11.1';
const ROOT = resolve(import.meta.dir, '..');

const CMAKE = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DBUILD_SHARED_LIBS=OFF',
  '-DBUILD_TESTING=OFF',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
  '-DJPEGXL_FORCE_SYSTEM_HWY=ON',
  '-DJPEGXL_FORCE_SYSTEM_BROTLI=ON',
  '-DJPEGXL_FORCE_SYSTEM_LCMS2=ON',
  '-DJPEGXL_ENABLE_SKCMS=OFF',
  // Everything that is not the encoder: this build writes JXL and reads none, so the tools,
  // the plugins, the JNI shim and the example decoders are minutes of compile for nothing.
  '-DJPEGXL_ENABLE_TOOLS=OFF',
  '-DJPEGXL_ENABLE_DEVTOOLS=OFF',
  '-DJPEGXL_ENABLE_EXAMPLES=OFF',
  '-DJPEGXL_ENABLE_BENCHMARK=OFF',
  '-DJPEGXL_ENABLE_VIEWERS=OFF',
  '-DJPEGXL_ENABLE_PLUGINS=OFF',
  '-DJPEGXL_ENABLE_JNI=OFF',
  '-DJPEGXL_ENABLE_SJPEG=OFF',
  '-DJPEGXL_ENABLE_OPENEXR=OFF',
  '-DJPEGXL_ENABLE_DOXYGEN=OFF',
  '-DJPEGXL_ENABLE_MANPAGES=OFF',
];
const RECIPE = pin(VERSION, CMAKE);
const HOME = pinnedHome(NAME, RECIPE);
const SOURCE = resolve(HOME, `libjxl-${VERSION}`);

function run(command: string, args: string[], cwd = ROOT): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}

function main(): void {
  makeOnce(HOME, RECIPE, process.env.BOWERBIRD_REBUILD_LIBJXL != null, build);
  linkPinned(NAME, HOME);
  console.log(`libjxl ${VERSION} at ${HOME}`);
}

/**
 * Where lcms2 is, on the one target libjxl cannot work it out for itself.
 *
 * highway it finds through vcpkg's own cmake config and brotli through `pkg-config`, but lcms2 it
 * looks for with a find module of its own, which comes back with neither the library nor the
 * header on a Windows runner - where `pkg-config --modversion lcms2`, a few lines above, answered.
 * So it is handed both. Off Windows this is empty and the distribution's own search is what runs.
 *
 * The file is looked for rather than named, since which of these vcpkg writes is the port's to
 * decide, and an absent one is worth saying before a cmake configure says it less clearly.
 */
function lcms2(): string[] {
  const root = process.env.VCPKG_INSTALLATION_ROOT;
  const triplet = process.env.VCPKG_TARGET_TRIPLET;
  if (root == null || triplet == null) return [];
  const installed = resolve(root, 'installed', triplet);
  const names = ['lcms2.lib', 'liblcms2.lib', 'lcms2_static.lib'];
  const library = names.map((name) => resolve(installed, 'lib', name)).find(existsSync);
  if (library == null) {
    throw new Error(`none of ${names.join(', ')} is under ${resolve(installed, 'lib')}`);
  }
  return [`-DLCMS2_LIBRARY=${library}`, `-DLCMS2_INCLUDE_DIR=${resolve(installed, 'include')}`];
}

function build(): void {
  for (const dependency of ['libhwy', 'libbrotlienc', 'libbrotlidec', 'lcms2']) {
    if (installedVersion(dependency) == null) {
      throw new Error(`${dependency} is not installed, and libjxl is built against the system's`);
    }
  }

  const name = `v${VERSION}.tar.gz`;
  const url = `https://github.com/libjxl/libjxl/archive/refs/tags/${name}`;
  const tarball = resolve(HOME, name);
  run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', tarball, url]);
  // The twelve symbolic links in the archive are all here, all wrappers for a benchmark
  // `JPEGXL_ENABLE_BENCHMARK=OFF` never builds, and a Windows runner cannot write one.
  unpack(HOME, name, ['*/tools/benchmark/metrics/*']);
  rmSync(tarball, { force: true });

  run('cmake', [
    '-S',
    SOURCE,
    '-B',
    resolve(SOURCE, 'build'),
    `-DCMAKE_INSTALL_PREFIX=${HOME}`,
    ...CMAKE,
    ...lcms2(),
  ]);
  run('cmake', ['--build', resolve(SOURCE, 'build'), '--parallel', ...CMAKE_CONFIG]);
  run('cmake', ['--install', resolve(SOURCE, 'build'), ...CMAKE_CONFIG]);
  rmSync(SOURCE, { recursive: true, force: true });

  const built = resolve(HOME, 'include/jxl/encode.h');
  if (!existsSync(built)) {
    throw new Error(`libjxl built but wrote no ${built}`);
  }
}

main();

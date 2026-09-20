// Builds the pinned libavif into the user's cache, which `native/rawshim/.libavif/` then points
// at (`pinned.ts` says why it is not in the checkout).
//
//   bun run get:libavif
//
// `build.rs` looks here first and then at the system's, and refuses with this command's name when
// what it finds is too old. Nothing fetches during a build, for `get-slangc.ts`'s reason.
//
// **Why not the distribution's.** The gain map API arrived in 1.1 behind a compile flag and settled
// in 1.2; Ubuntu 24.04 ships 1.0.4 and Debian trixie 1.1.1 with the flag off, so neither has the
// symbols at all and an AVIF's gain map cannot be reached. Building one is what makes the two hosts
// agree about a photograph rather than having its highlights depend on which machine read it.
//
// **The codecs are the system's, deliberately.** libaom encodes every AVIF this application writes,
// so building a copy of it here would change what a rendition *is* - the fixture pins and the bench
// budget are both measured against the encoder on the machine. This builds the container and the
// colour conversion around the same libaom and libdav1d that are already installed.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { linkPinned, makeOnce, pin, pinnedHome } from './pinned';

const NAME = 'libavif';
// 1.2.0 is the floor: the release that took the gain map API out of experimental and removed the
// `AVIF_ENABLE_EXPERIMENTAL_GAIN_MAP` flag it used to sit behind.
const VERSION = '1.4.2';
const ROOT = resolve(import.meta.dir, '..');

const CMAKE = [
  '-DCMAKE_BUILD_TYPE=Release',
  // Static, so nothing has to be on a loader path at run time and the binary this repo builds
  // does not depend on a directory inside the checkout still being there.
  '-DBUILD_SHARED_LIBS=OFF',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
  '-DAVIF_CODEC_AOM=SYSTEM',
  '-DAVIF_CODEC_DAV1D=SYSTEM',
  // The 4:2:0 encode's chroma solver (`avif.rs`, `SHARP_YUV`). Without it libavif box-averages
  // chroma over each 2x2 in PQ code space, and a channel at the gamut floor leaks its
  // near-black code noise into the bright one at 0.678 - a saturated red comes back speckled.
  '-DAVIF_LIBSHARPYUV=SYSTEM',
  '-DAVIF_LIBYUV=OFF',
  '-DAVIF_BUILD_APPS=OFF',
  '-DAVIF_BUILD_TESTS=OFF',
];
const RECIPE = pin(VERSION, CMAKE);
const HOME = pinnedHome(NAME, RECIPE);
const SOURCE = resolve(HOME, `libavif-${VERSION}`);

function run(command: string, args: string[], cwd = ROOT): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}

/** What `pkg-config` reports for a system library, or null where there is none. */
function installed(name: string): string | null {
  const done = spawnSync('pkg-config', ['--modversion', name], { encoding: 'utf8' });
  return done.status === 0 ? done.stdout.trim() : null;
}

function main(): void {
  makeOnce(HOME, RECIPE, process.env.BOWERBIRD_REBUILD_LIBAVIF != null, build);
  linkPinned(NAME, HOME);
  console.log(`libavif ${VERSION} at ${HOME}`);
}

function build(): void {
  // Named rather than vendored: a build that quietly fell back to libavif's own bundled codecs
  // would encode every rendition with a different aom than the budget was recorded against.
  for (const codec of ['aom', 'dav1d', 'libsharpyuv']) {
    if (installed(codec) == null) {
      throw new Error(`${codec} is not installed, and libavif is built against the system's`);
    }
  }

  const name = `v${VERSION}.tar.gz`;
  const url = `https://github.com/AOMediaCodec/libavif/archive/refs/tags/${name}`;
  const tarball = resolve(HOME, name);
  run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', tarball, url]);
  run('tar', ['xzf', tarball, '-C', HOME]);
  rmSync(tarball, { force: true });

  run('cmake', ['-S', SOURCE, '-B', resolve(SOURCE, 'build'), `-DCMAKE_INSTALL_PREFIX=${HOME}`, ...CMAKE]);
  run('cmake', ['--build', resolve(SOURCE, 'build'), '--parallel']);
  run('cmake', ['--install', resolve(SOURCE, 'build')]);
  // The tree the build ran in is tens of megabytes of objects nothing reads again.
  rmSync(SOURCE, { recursive: true, force: true });

  const built = resolve(HOME, 'lib/pkgconfig/libavif.pc');
  if (!existsSync(built)) {
    throw new Error(`libavif built but wrote no ${built}`);
  }
}

main();

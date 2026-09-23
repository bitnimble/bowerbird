// Builds libavif and libjxl, and aom, dav1d, sharpyuv, highway, brotli and lcms2 under them, into
// the user's cache, which `native/rawshim/.codecs/` then points at (`pinned.ts` says why it is not
// in the checkout).
//
//   bun run get:codecs
//
// Through vcpkg (`vcpkg.ts`), so a rendition is encoded by the same aom wherever the app was built
// (DESIGN §23.7), and every library is static: `rawshim` asks the reader's machine for nothing but
// its C and C++ runtimes.
//
// **Why not the distributions' libavif and libjxl.** The gain map API settled in libavif 1.2, and
// Ubuntu 24.04 ships 1.0.4 and Debian trixie 1.1.1 with it behind a flag, so an AVIF's gain map
// could not be read at all. libjxl's encoder settled in 0.10 and the distributions ship 0.7.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { linkPinned, makeOnce, pinnedHome } from './pinned';
import { hostPath, TRIPLET, vcpkgInstall, vcpkgRecipe, WINDOWS } from './vcpkg';

const NAME = 'codecs';
const RECIPE = vcpkgRecipe(NAME, import.meta.path);
const HOME = pinnedHome(NAME, RECIPE);
/** What `build.rs` reads the whole link from, relative to `HOME`. */
const LINK = 'link.txt';
const MODULES = ['libavif', 'libjxl', 'libjxl_threads', 'libjxl_cms'];

function main(): void {
  makeOnce(HOME, RECIPE, process.env.BOWERBIRD_REBUILD_CODECS != null, build);
  linkPinned(NAME, HOME);
  console.log(`codecs (${TRIPLET}) at ${HOME}`);
}

function build(): void {
  const installed = resolve(HOME, 'installed');
  // pkg-config and python3 for dav1d's meson; nasm for aom's and dav1d's x86 assembly.
  vcpkgInstall(installed, NAME, ['pkg-config', 'python3', ...(process.arch === 'x64' ? ['nasm'] : [])], true);

  // The one decision the overlay port exists for, checked where it would have gone missing: a
  // libavif without sharpyuv links, and then answers `NOT_IMPLEMENTED` to every 4:2:0 encode.
  const avif = readFileSync(resolve(installed, TRIPLET, 'lib/pkgconfig/libavif.pc'), 'utf8');
  if (!avif.includes('libsharpyuv')) throw new Error('vcpkg built libavif without sharpyuv');

  writeFileSync(resolve(HOME, LINK), `${linkLines(installed).join('\n')}\n`);
}

/**
 * The link line `pkgconf --static` gives for the four libraries `rawshim` binds, as the lines
 * `build.rs` turns into cargo's: `include`, `search`, `static` and `dylib`.
 *
 * Asked of the tree's own pkgconf with only the tree's `.pc` files visible, so nothing on the build
 * machine can reach the link. `static` is a library whose archive is in the tree, in the order a
 * single-pass linker needs; `dylib` is the platform's own (`m`, `pthread`).
 */
function linkLines(installed: string): string[] {
  const target = resolve(installed, TRIPLET);
  const pkgconf = hostPath(installed, `tools/pkgconf/${WINDOWS ? 'pkgconf.exe' : 'pkgconf'}`);
  const asked = spawnSync(pkgconf, ['--static', '--libs', ...MODULES], {
    encoding: 'utf8',
    env: { ...process.env, PKG_CONFIG_LIBDIR: resolve(target, 'lib/pkgconfig'), PKG_CONFIG_PATH: '' },
  });
  if (asked.status !== 0) throw new Error(`pkgconf --static --libs ${MODULES.join(' ')}: ${asked.stderr}`);

  const inside = (path: string): string => {
    const at = relative(HOME, resolve(path));
    if (at.startsWith('..')) throw new Error(`pkgconf named ${path}, which is outside ${HOME}`);
    return at.replaceAll('\\', '/');
  };
  const archive = (library: string): string => resolve(target, 'lib', WINDOWS ? `${library}.lib` : `lib${library}.a`);

  const libraries: string[] = [];
  const lines = [`include ${inside(resolve(target, 'include'))}`];
  for (const token of asked.stdout.trim().split(/\s+/)) {
    if (token.startsWith('-L')) lines.push(`search ${inside(token.slice(2))}`);
    else if (token.startsWith('-l')) libraries.push(token.slice(2));
    else if (token === '-pthread') libraries.push('pthread');
    else throw new Error(`pkgconf gave ${token}, which build.rs has no way to pass on`);
  }
  // The last mention of each kept, which is where pkgconf puts a library after everything needing it.
  const ordered = libraries.filter((library, at) => libraries.lastIndexOf(library) === at);
  for (const library of ordered) lines.push(`${existsSync(archive(library)) ? 'static' : 'dylib'} ${library}`);
  return [...new Set(lines)];
}

main();

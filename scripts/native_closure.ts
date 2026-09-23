// What `rawshim` needs from outside itself, parsed out of the two loaders that name anything
// (DESIGN §23.7.1). `build-sidecar.ts` is what then carries the Linux runtime and refuses anything
// on macOS. Windows has no arm here: `rawshim.dll` asks for nothing the shell does not.

/**
 * The glibc members no application may carry a second copy of.
 *
 * Two C libraries in one process is two allocators and two `errno`. `libcrypt` is deliberately
 * absent, being libxcrypt on every current distribution rather than a member of this list.
 */
const GLIBC = [
  'libc.so',
  'libm.so',
  'libmvec.so',
  'libdl.so',
  'libpthread.so',
  'librt.so',
  'libresolv.so',
  'libanl.so',
  'libutil.so',
  'libnsl.so',
  'libBrokenLocale.so',
];

/** Every library an `ldd` walk resolved, less those. `ldd` is transitive, so one call is all. */
export function elfClosure(walk: string): string[] {
  refuseMissing(walk);
  return resolvedPaths(walk).filter((path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return !name.startsWith('ld-linux') && !GLIBC.some((member) => name.startsWith(member));
  });
}

/** `ldd` exits 0 on a name it could not place, so nothing else here would notice. */
function refuseMissing(walk: string): void {
  const missing = walk.split('\n').filter((line) => line.includes('=> not found'));
  if (missing.length > 0) {
    throw new Error(`a dependency could not be placed:${missing.join('')}`);
  }
}

function resolvedPaths(walk: string): string[] {
  return walk
    .split('\n')
    .map((line) => line.split('=>')[1]?.replace(/\(0x[0-9a-f]+\)\s*$/i, '').trim() ?? '')
    .filter((path) => path.startsWith('/'));
}

/**
 * Every name one Mach-O will look for, less the ones the OS owns and its own - so what a reader's
 * Mac would have to supply.
 *
 * `@`-prefixed entries come back too, and deliberately: an `@rpath` name is still a library asked
 * of whatever search path the process has. A dylib's own install name is dropped by sharing the
 * file's basename.
 */
export function machNames(listing: string, self: string): string[] {
  return listing
    .split('\n')
    .filter((line) => /^\s/.test(line))
    .map((line) => line.replace(/\(compatibility version .*$/, '').trim())
    .filter((path) => path !== '' && path.slice(path.lastIndexOf('/') + 1) !== self)
    .filter((path) => !path.startsWith('/usr/lib/') && !path.startsWith('/System/'));
}


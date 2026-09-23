// Builds libavif and libjxl, and aom, dav1d, sharpyuv, highway, brotli and lcms2 under them, into
// the user's cache, which `native/rawshim/.codecs/` then points at (`pinned.ts` says why it is not
// in the checkout).
//
//   bun run get:codecs
//
// Through vcpkg, at one commit of its port tree, which fixes every library's version - and the
// vcpkg tool's - on every machine that builds this application. So a rendition is encoded by the
// same aom wherever the app was built (DESIGN §23.7.1), and every library is static: `rawshim`
// asks the reader's machine for nothing but its C and C++ runtimes.
//
// `native/rawshim/vcpkg/` is the manifest, and the two things vcpkg's defaults get wrong for us:
// an overlay libavif that builds against sharpyuv rather than libyuv, and triplets that skip the
// debug builds and pin macOS's deployment target.
//
// **Why not the distributions' libavif and libjxl.** The gain map API settled in libavif 1.2, and
// Ubuntu 24.04 ships 1.0.4 and Debian trixie 1.1.1 with it behind a flag, so an AVIF's gain map
// could not be read at all. libjxl's encoder settled in 0.10 and the distributions ship 0.7.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { linkPinned, makeOnce, pin, pinnedHome, unpack } from './pinned';

const NAME = 'codecs';
const VCPKG = '398e9a716997ec84676dc7c7afdd51afcede2269';
const ROOT = resolve(import.meta.dir, '..');
const MANIFEST = resolve(ROOT, 'native/rawshim/vcpkg');
const WINDOWS = process.platform === 'win32';
const TRIPLET = triplet();
const RECIPE = pin(VCPKG, [TRIPLET, ...manifest()]);
const HOME = pinnedHome(NAME, RECIPE);
/** What `build.rs` reads the whole link from, relative to `HOME`. */
const LINK = 'link.txt';
const MODULES = ['libavif', 'libjxl', 'libjxl_threads', 'libjxl_cms'];

function main(): void {
  makeOnce(HOME, RECIPE, process.env.BOWERBIRD_REBUILD_CODECS != null, build);
  linkPinned(NAME, HOME);
  console.log(`codecs (vcpkg ${VCPKG.slice(0, 10)}, ${TRIPLET}) at ${HOME}`);
}

function triplet(): string {
  const known: Record<string, string> = {
    'linux-x64': 'x64-linux',
    'darwin-arm64': 'arm64-osx',
    'win32-x64': 'x64-windows-static-md',
  };
  const machine = `${process.platform}-${process.arch}`;
  const found = known[machine];
  if (found == null) {
    throw new Error(`no vcpkg triplet for ${machine}: name one here and in native/rawshim/vcpkg/triplets`);
  }
  return found;
}

/** Every file under the manifest directory, so an edit to any of them rebuilds. */
function manifest(): string[] {
  const files: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at).sort()) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      // Line endings normalised, or a Windows checkout would name a different tree for the same files.
      else files.push(`${relative(MANIFEST, path).replaceAll('\\', '/')}\n${readFileSync(path, 'utf8').replaceAll('\r\n', '\n')}`);
    }
  };
  walk(MANIFEST);
  return files;
}

function build(): void {
  refuseMissingTools();
  // vcpkg's own root and its build trees, somewhere short: the trees nest deep enough to pass
  // Windows' 260-character path limit under a cache directory, and run to gigabytes. Thrown away
  // once the tree is made, and kept when it is not, since the logs a failure names are in it.
  const work = mkdtempSync(join(tmpdir(), 'bb-codecs-'));
  try {
    const name = `${VCPKG}.tar.gz`;
    run('curl', ['--proto', '=https', '--tlsv1.2', '-fsSL', '-o', join(work, name), `https://github.com/microsoft/vcpkg/archive/${name}`]);
    unpack(work, name);
    const root = join(work, `vcpkg-${VCPKG}`);
    if (WINDOWS) run('cmd', ['/c', 'bootstrap-vcpkg.bat', '-disableMetrics'], root);
    else run('sh', ['bootstrap-vcpkg.sh', '-disableMetrics'], root);

    const installed = resolve(HOME, 'installed');
    run(join(root, WINDOWS ? 'vcpkg.exe' : 'vcpkg'), [
      'install',
      // Named rather than found, because the CI runners set `VCPKG_ROOT` to the vcpkg they carry,
      // and the tool would build that one's ports instead.
      `--vcpkg-root=${root}`,
      `--x-manifest-root=${MANIFEST}`,
      `--x-install-root=${installed}`,
      `--x-buildtrees-root=${join(work, 'b')}`,
      `--x-packages-root=${join(work, 'p')}`,
      `--downloads-root=${join(work, 'd')}`,
      `--triplet=${TRIPLET}`,
      '--clean-after-build',
    ]);

    // The one decision the overlay port exists for, checked where it would have gone missing: a
    // libavif without sharpyuv links, and then answers `NOT_IMPLEMENTED` to every 4:2:0 encode.
    const avif = readFileSync(resolve(installed, TRIPLET, 'lib/pkgconfig/libavif.pc'), 'utf8');
    if (!avif.includes('libsharpyuv')) throw new Error('vcpkg built libavif without sharpyuv');

    writeFileSync(resolve(HOME, LINK), `${linkLines(installed).join('\n')}\n`);
  } catch (failed) {
    console.error(`vcpkg's build trees and logs are kept at ${work}`);
    throw failed;
  }
  rmSync(work, { recursive: true, force: true });
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
  const asked = spawnSync(pkgconf(installed), ['--static', '--libs', ...MODULES], {
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

/** The pkgconf vcpkg built for the machine doing the build, whichever host triplet that is. */
function pkgconf(installed: string): string {
  for (const host of readdirSync(installed)) {
    const tool = resolve(installed, host, 'tools/pkgconf', WINDOWS ? 'pkgconf.exe' : 'pkgconf');
    if (existsSync(tool)) return tool;
  }
  throw new Error(`vcpkg installed no pkgconf under ${installed}`);
}

/**
 * vcpkg fetches its own tools on Windows and expects them installed everywhere else, and says so
 * one port at a time, minutes apart. Asked for here, all at once.
 */
function refuseMissingTools(): void {
  if (WINDOWS) return;
  const wanted = ['curl', 'git', 'tar', 'zip', 'unzip', 'pkg-config', 'python3'];
  // aom and dav1d assemble with it on x86 only.
  if (process.arch === 'x64') wanted.push('nasm');
  const missing = wanted.filter((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status !== 0);
  if (missing.length > 0) {
    throw new Error(
      `vcpkg needs ${missing.join(', ')} to build the codecs. ` +
        (process.platform === 'darwin' ? `brew install ${missing.join(' ')}` : `sudo apt-get install ${missing.join(' ')}`),
    );
  }
}

function run(command: string, args: string[], cwd = ROOT): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, VCPKG_DISABLE_METRICS: '1' } });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}

main();

// Pull mingw-w64 packages and their dependency closure out of the MSYS2 repo, and
// extract them into a local prefix. No MSYS2 install, no pacman: the packages are just
// zstd tarballs over HTTP, and `.PKGINFO` lists what each one needs.
//
// This is what makes a Windows build possible from Linux at all. `rawshim` links LibRaw,
// lensfun and libavif, and for an MSVC target there is no way to get those here short of
// building them and their dependencies from source. MSYS2 has them prebuilt for MinGW,
// which is why `win-build.ts` targets `x86_64-pc-windows-gnu`.
//
//   bun run msys:fetch libraw lensfun libavif
//
// A few names go unresolved every time - `cc-libs`, `libjpeg`, `omp`, `libsharpyuv` are
// virtual or provided under another name - and none of them has been missing from the
// resulting tree, so an unfound dependency is reported rather than fatal.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = 'https://mirror.msys2.org/mingw/mingw64/';
const CACHE = '/tmp/msys-cache';
const PREFIX = process.env.MSYS_PREFIX ?? `${process.env.HOME}/local/mingw64`;
mkdirSync(CACHE, { recursive: true });
mkdirSync(PREFIX, { recursive: true });

const listing = await (await fetch(REPO)).text();
const files = [...listing.matchAll(/mingw-w64-x86_64-[^"<]*?\.pkg\.tar\.zst(?!\.sig)/g)].map((m) => m[0]);

// Newest build wins where a name appears more than once.
const byName = new Map();
for (const file of files) {
  const name = file.replace(/^mingw-w64-x86_64-/, '').replace(/-[^-]+-[^-]+-any\.pkg\.tar\.zst$/, '');
  byName.set(name, file);
}

const done = new Set();
const queue = process.argv.slice(2);
const missing = [];

while (queue.length > 0) {
  const name = queue.shift();
  if (done.has(name)) continue;
  done.add(name);
  const file = byName.get(name);
  if (file == null) {
    missing.push(name);
    continue;
  }
  const path = join(CACHE, file);
  if (!existsSync(path)) {
    const res = await fetch(REPO + file);
    if (!res.ok) {
      missing.push(name);
      continue;
    }
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  execFileSync('tar', ['--use-compress-program=unzstd', '-xf', path, '-C', PREFIX], { stdio: 'ignore' });

  // .PKGINFO sits at the archive root; `depend = foo` lines name mingw-w64-x86_64-*.
  const info = execFileSync('tar', ['--use-compress-program=unzstd', '-xOf', path, '.PKGINFO'], {
    encoding: 'utf8',
  });
  for (const line of info.split('\n')) {
    const dep = line.match(/^depend = mingw-w64-x86_64-([^>=<\s]+)/);
    if (dep != null) queue.push(dep[1]);
  }
}

console.log(`installed ${done.size - missing.length} packages into ${PREFIX}`);
if (missing.length > 0) console.log('not found:', missing.join(', '));

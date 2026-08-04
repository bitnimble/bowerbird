// Pull aarch64 Android packages out of the Termux repository and extract them locally.
//
// Termux is a prebuilt Android repo, which makes it the analogue of osxcross-macports and
// MSYS2 for the third target: LibRaw compiled for `aarch64-linux-android` without a
// from-source NDK cross-build. The packages are ordinary `.deb`s, so `dpkg -x` unpacks
// them, and they carry Termux's own absolute prefix - harmless, because `android-build.ts`
// links LibRaw statically and the prefix never reaches the APK.
//
//   bun run scripts/termux-fetch.ts libraw libraw-static
//
// `TERMUX_PREFIX` says where to unpack; /tmp/android-prefix otherwise.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'https://packages.termux.dev/apt/termux-main';
const PREFIX = process.env.TERMUX_PREFIX ?? '/tmp/android-prefix';
const CACHE = '/tmp/termux-cache';

const wanted = process.argv.slice(2);
if (wanted.length === 0) {
  console.error('usage: termux-fetch.ts <package>...');
  process.exit(1);
}

mkdirSync(CACHE, { recursive: true });
mkdirSync(PREFIX, { recursive: true });

const index = await (await fetch(`${REPO}/dists/stable/main/binary-aarch64/Packages`, {
  redirect: 'follow',
})).text();

// One stanza per package; `Filename` is its path under the pool.
const listed = new Map<string, string>();
for (const stanza of index.split('\n\n')) {
  const name = stanza.match(/^Package: (.*)$/m)?.[1];
  const file = stanza.match(/^Filename: (.*)$/m)?.[1];
  if (name != null && file != null) listed.set(name, file);
}

for (const name of wanted) {
  const file = listed.get(name);
  if (file == null) {
    console.error(`${name}: not in the Termux index`);
    process.exitCode = 1;
    continue;
  }
  const path = join(CACHE, file.split('/').pop() ?? `${name}.deb`);
  const res = await fetch(`${REPO}/${file}`, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`${name}: ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  await Bun.write(path, await res.arrayBuffer());
  execFileSync('dpkg', ['-x', path, PREFIX]);
  console.error(`${name}: extracted into ${PREFIX}`);
}

// Where a pinned tree lives, and what it was fetched or built from, so a stale one is replaced
// rather than built against.
//
// Every getter's "is it already here" is a file existing, and a version bump or a changed build
// flag leaves the old tree exactly where the new one goes. Silent, and it reaches the application:
// a libavif built before `AVIF_LIBSHARPYUV` was asked for stayed in `.libavif` and answered
// `NOT_IMPLEMENTED` to every 4:2:0 encode, which is every grid tile in a library.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const STAMP = 'bowerbird-pin.json';
const CRATE = resolve(import.meta.dir, '../native/rawshim');
const ABANDONED = 60 * 60 * 1000;

/** A version and the decisions taken with it, as the one string a tree is compared by. */
export function pin(version: string, inputs: readonly string[] = []): string {
  return JSON.stringify({ version, inputs }, null, 2);
}

/**
 * The tree is under the user's cache rather than in the checkout, so the worktrees on a machine
 * share one build of libavif instead of each paying for its own. A directory per recipe, because
 * two worktrees on different pins would otherwise take turns deleting each other's.
 */
export function pinnedHome(name: string, recipe: string): string {
  const cache = process.env.XDG_CACHE_HOME || resolve(homedir(), '.cache');
  const identity = createHash('sha256').update(recipe).digest('hex').slice(0, 16);
  return resolve(cache, 'bowerbird', name, identity);
}

/** The path `build.rs`, the Dockerfile and `VK_ADD_DRIVER_FILES` all know a pinned tree by. */
export function pinnedLink(name: string): string {
  return resolve(CRATE, `.${name}`);
}

/**
 * Whatever is at the link goes first, so a directory someone put there by hand cannot win over the
 * tree this getter just made.
 */
export function linkPinned(name: string, home: string): void {
  // The Docker stage that fetches a tree copies in the scripts and nothing else, so the crate
  // directory the link goes in is not there to link into.
  mkdirSync(CRATE, { recursive: true });
  rmSync(pinnedLink(name), { recursive: true, force: true });
  // A directory symlink on Windows needs Developer Mode or elevation; a junction needs neither
  // and is the same thing to every reader of the path.
  symlinkSync(home, pinnedLink(name), process.platform === 'win32' ? 'junction' : undefined);
}

/**
 * What `cmake --build` and `cmake --install` need on Windows, whose default generator is Visual
 * Studio: a multi-config generator ignores `CMAKE_BUILD_TYPE` and takes the configuration here
 * instead. Every other generator ignores it.
 *
 * Deliberately not a configure flag. The configure flags are the recipe a tree is named by
 * (`pin`), so anything added there rebuilds libavif on every machine that already has it.
 */
export const CMAKE_CONFIG: readonly string[] = process.platform === 'win32' ? ['--config', 'Release'] : [];

/**
 * What a system library reports for its version, or null where there is none.
 *
 * **Two names, because the binary is not called the same thing everywhere.** The Unixes ship
 * `pkg-config`; vcpkg's tree and MSYS2 ship `pkgconf`, which answers the same queries under a
 * different name, and a Windows runner has neither until one is installed. Asking for only the
 * first is how a getter refuses on a machine that has every library it wants.
 */
export function installedVersion(name: string): string | null {
  let asked = false;
  for (const tool of ['pkg-config', 'pkgconf']) {
    const answer = spawnSync(tool, ['--modversion', name], { encoding: 'utf8' });
    // `error` is the tool not being there at all, where a non-zero status is it answering that
    // it has never heard of the library. Told apart because the message below is otherwise a
    // lie in the one case a reader cannot check: an image holding every library and no
    // `pkg-config` reports the first library as missing, and installing it changes nothing.
    if (answer.error == null) asked = true;
    if (answer.status === 0) return answer.stdout.trim();
  }
  if (!asked) {
    throw new Error(
      `neither pkg-config nor pkgconf is installed, so whether ${name} is here cannot be asked`,
    );
  }
  return null;
}

/**
 * Unpacks an archive already sitting in `home`, named rather than pathed.
 *
 * **The name, from inside the directory, because `tar` reads a Windows path as a remote host.**
 * `tar xzf C:\...` is a drive letter to a reader and `user@host:path` to GNU tar, which then
 * fails with "Cannot connect to C: resolve failed" - and every path a getter builds on Windows
 * is absolute.
 */
export function unpack(home: string, name: string): void {
  const done = spawnSync('tar', ['xzf', name], { cwd: home, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`tar xzf ${name} in ${home} exited ${done.status}`);
  }
}

/**
 * Makes the tree, once, however many worktrees ask for it at the same moment: the others wait and
 * then find the stamp the winner wrote. Without this two of them both clear `home` and write into
 * it, and every worktree links against the interleaving.
 *
 * `make` is called with `home` empty and existing, and must leave the finished tree in it.
 */
export function makeOnce(home: string, recipe: string, force: boolean, make: () => void): void {
  if (alreadyPinned(home, recipe) && !force) {
    return;
  }

  const lock = `${home}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let held: number | null = null;
  while (held == null) {
    try {
      held = openSync(lock, 'wx');
    } catch (failed) {
      if ((failed as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw failed;
      }
      // Released between the open and here, so the next open is likely to take it.
      const heldSince = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (heldSince == null) {
        continue;
      }
      // A process killed mid-build leaves its lock behind, and nothing else would ever take it.
      if (Date.now() - heldSince > ABANDONED) {
        rmSync(lock, { force: true });
        continue;
      }
      console.log(`waiting for another ${home} to finish`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      if (alreadyPinned(home, recipe) && !force) {
        return;
      }
    }
  }

  try {
    if (alreadyPinned(home, recipe) && !force) {
      return;
    }
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    make();
    recordPin(home, recipe);
  } finally {
    closeSync(held);
    rmSync(lock, { force: true });
  }
}

/** Whether what is at `home` was made from this recipe. */
export function alreadyPinned(home: string, recipe: string): boolean {
  try {
    return readFileSync(resolve(home, STAMP), 'utf8') === recipe;
  } catch {
    return false;
  }
}

/** Written last, so a build that failed part way leaves nothing claiming to be finished. */
export function recordPin(home: string, recipe: string): void {
  writeFileSync(resolve(home, STAMP), recipe);
}

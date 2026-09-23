// Where a pinned tree lives, and what it was fetched or built from, so a stale one is replaced
// rather than built against.
//
// Every getter's "is it already here" is a file existing, and a version bump or a changed build
// flag leaves the old tree exactly where the new one goes. Silent, and it reaches the application:
// a libavif built without sharpyuv answers `NOT_IMPLEMENTED` to every 4:2:0 encode, which is every
// grid tile in a library, and a tree from before the flag would sit where the new one belongs.
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
 * Unpacks an archive already sitting in `home`, named rather than pathed, less whatever `without`
 * matches.
 *
 * **The name, from inside the directory, because `tar` reads a Windows path as a remote host.**
 * `tar xzf C:\...` is a drive letter to a reader and `user@host:path` to GNU tar, which then
 * fails with "Cannot connect to C: resolve failed" - and every path a getter builds is absolute.
 *
 * `without` is for the entries Windows cannot write at all: a symbolic link needs a privilege the
 * runner does not hold, and tar fails the whole extraction over one rather than skipping it.
 */
export function unpack(home: string, name: string, without: readonly string[] = []): void {
  const args = ['xzf', name, ...without.map((it) => `--exclude=${it}`)];
  const done = spawnSync('tar', args, { cwd: home, stdio: 'inherit' });
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

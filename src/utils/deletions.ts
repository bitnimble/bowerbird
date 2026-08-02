import { existsSync, unlinkSync } from 'node:fs';
import { rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import { containsPath } from './paths';
import { findOriginalsAnywhere, isSupportedFile } from './scan';

// The only module allowed to remove anything from disk: the `no-restricted-imports`
// rule in .oxlintrc.json bans the fs deletion calls everywhere else. Originals are
// the one thing here that cannot be regenerated, so every deletion goes through a
// guard that proves its target is not one before the call is made.

// The subdirectories of a data directory that hold generated files, and so the
// only ones a file may be deleted from one at a time. Everything else under there
// - the sync lock, a stray the user left - is not ours to remove.
const GENERATED_DIRS = ['renditions', 'hdr'];

// Lives here rather than beside the lock's own code so the guard below and the
// name it guards cannot drift apart.
export const SYNC_LOCK_NAME = '.bowerbird-sync.lock';

// A generated rendition or HDR check file. `dataPath` is passed rather than
// derived from `target` so the guard is checked against the caller's own library
// rather than against whatever directory the path happens to sit in.
export async function deleteGeneratedFile(dataPath: string, target: string): Promise<void> {
  if (!GENERATED_DIRS.some((dir) => containsPath(path.join(dataPath, dir), target))) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: not a generated file under ${dataPath}`);
  }
  // A RAW under `renditions/` would pass the check above and still be an original:
  // the extension is what decides, everywhere else in the system too.
  if (isSupportedFile(target)) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: it is an original`);
  }
  await rm(target, { force: true });
}

// An emptied generated directory - one nothing writes to any more, once the sweep
// has taken everything out of it. Non-recursive on purpose: `rmdir` fails while a
// file is left, so a rendition that would not go keeps its directory until a later
// sweep, and no tree can be removed here by mistake.
export async function deleteGeneratedDirectory(dataPath: string, target: string): Promise<void> {
  if (!GENERATED_DIRS.some((dir) => containsPath(path.join(dataPath, dir), target))) {
    throw new AppError('IO_ERROR', `refusing to remove ${target}: not a generated directory under ${dataPath}`);
  }
  await rmdir(target);
}

// The whole data directory, when its library is removed. Refuses while any
// original is still inside it: the caller is expected to have moved those
// somewhere permanent first (the library's Bin). A data directory holding
// originals is either a pre-Bin-move layout or a `data_path` aimed at the user's
// photographs, and neither is a tree to delete.
export async function deleteDataDirectory(dataPath: string): Promise<void> {
  const strays = await findOriginalsAnywhere(dataPath);
  if (strays.length > 0) {
    throw new AppError('IO_ERROR', `refusing to delete ${dataPath}: it still holds ${strays.length} original file(s)`);
  }
  await rm(dataPath, { recursive: true, force: true });
}

// Synchronous to match the lock itself: acquiring one has to be a single
// uninterrupted step, or two syncs of the same library can both pass the
// staleness check before either creates the file.
export function deleteSyncLockSync(lockPath: string): void {
  if (path.basename(lockPath) !== SYNC_LOCK_NAME) {
    throw new AppError('IO_ERROR', `refusing to delete ${lockPath}: not a sync lock`);
  }
  unlinkSync(lockPath);
}

// The source half of a move: `movedTo` already holds the bytes (a hard link to
// the same inode, or a completed copy), so removing `from` loses nothing. That
// the destination exists is the entire safety argument, which is why it is
// checked here rather than trusted from the caller.
export async function unlinkMovedFile(from: string, movedTo: string): Promise<void> {
  if (!existsSync(movedTo)) {
    throw new AppError('IO_ERROR', `refusing to remove ${from}: ${movedTo} does not exist`);
  }
  await unlink(from);
}

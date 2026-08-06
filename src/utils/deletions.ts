import { existsSync } from 'node:fs';
import { rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import type { Library } from '../schemas/libraries';
import { containsPath, getBinPath } from './paths';
import { findOriginalsAnywhere, isSupportedFile } from './scan';

// The only module allowed to remove anything from disk: the `no-restricted-imports`
// rule in .oxlintrc.json bans the fs deletion calls everywhere else. Originals are
// the one thing here that cannot be regenerated, so every deletion goes through a
// guard that proves its target is not one before the call is made.

// The subdirectories of a data directory that hold generated files, and so the
// only ones a file may be deleted from one at a time. Everything else under
// there - a stray the user left - is not ours to remove.
const GENERATED_DIRS = ['renditions', 'hdr'];

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
// original is still inside it: nothing under `DATA_DIR` is written by anyone but
// this app (§6), so an original there means the directory is not what it is
// believed to be, and this is the one call here that cannot be undone.
export async function deleteDataDirectory(dataPath: string): Promise<void> {
  const strays = await findOriginalsAnywhere(dataPath);
  if (strays.length > 0) {
    throw new AppError('IO_ERROR', `refusing to delete ${dataPath}: it still holds ${strays.length} original file(s)`);
  }
  await rm(dataPath, { recursive: true, force: true });
}

// The bin folder a failed library create (or a failed flag clear) left behind,
// which the "a folder of that name already exists" refusal would otherwise make
// permanent: the library could never be created with that bin name again.
//
// Both guards matter, because this runs on an error path where the thing it is
// about to delete is a directory the app believes it just created and might be
// wrong about: it must be exactly this library's bin, and `rmdir` fails while
// anything at all is inside it.
export async function deleteEmptyBinFolder(library: Pick<Library, 'root_path' | 'bin_name'>, target: string): Promise<void> {
  const bin = getBinPath(library);
  if (bin == null || path.resolve(target) !== path.resolve(bin)) {
    throw new AppError('IO_ERROR', `refusing to remove ${target}: not this library's bin folder`);
  }
  await rmdir(target);
}

// A snapshot of the catalogue, rotated out or abandoned part-written (§4.9).
// Directly inside the backup directory rather than anywhere beneath it: that
// directory holds nothing but flat files this app wrote, and a subtree under it
// is something somebody else put there.
export async function deleteBackupFile(backupsDir: string, target: string): Promise<void> {
  if (path.dirname(path.resolve(target)) !== path.resolve(backupsDir)) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: not a file in ${backupsDir}`);
  }
  // The same last word as everywhere else: whatever a directory is supposed to
  // hold, a RAW in it is an original.
  if (isSupportedFile(target)) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: it is an original`);
  }
  await rm(target, { force: true });
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

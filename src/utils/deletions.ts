import { existsSync } from 'node:fs';
import { rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../errors';
import type { BlobVerifyResponse } from '../schemas/blobs';
import type { Library } from '../schemas/libraries';
import { contentHash } from './hash';
import { containsPath, getBinPath } from './paths';
import { findOriginalsAnywhere, isStrayOriginal } from './scan';

// The only module allowed to remove anything from disk: the `no-restricted-imports`
// rule in .oxlintrc.json bans the fs deletion calls everywhere else. Originals are
// the one thing here that cannot be regenerated, so every deletion either proves
// its target is not one before the call is made, or *derives* that target from
// something that cannot name one. Nothing here deletes a path a caller chose.

// The subdirectories of a data directory that hold generated files, and so the
// only ones a file may be deleted from one at a time. Everything else under
// there - a stray the user left - is not ours to remove.
const GENERATED_DIRS = ['renditions', 'hdr', 'drafts'];

/**
 * A scratch directory this process made under the OS temp directory, and everything in it.
 *
 * An export renders to one of these and reads it back (§10.5), so the tree being removed holds
 * only what was written into it seconds earlier. The guard is the location: a library lives
 * where the user put it, and no original can be under `tmpdir()` unless someone put it there,
 * which is not a case this has to survive.
 */
export async function deleteScratchDirectory(target: string): Promise<void> {
  const scratch = path.resolve(tmpdir());
  if (!containsPath(scratch, target) || path.resolve(target) === scratch) {
    throw new AppError('IO_ERROR', `refusing to remove ${target}: not a scratch directory under ${scratch}`);
  }
  await rm(target, { recursive: true, force: true });
}

// A generated rendition or HDR check file. `dataPath` is passed rather than
// derived from `target` so the guard is checked against the caller's own library
// rather than against whatever directory the path happens to sit in.
export async function deleteGeneratedFile(dataPath: string, target: string): Promise<void> {
  if (!GENERATED_DIRS.some((dir) => containsPath(path.join(dataPath, dir), target))) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: not a generated file under ${dataPath}`);
  }
  // A RAW under `renditions/` would pass the check above and still be an original:
  // the extension is what decides, everywhere else in the system too.
  if (isStrayOriginal(target)) {
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

// One entry of a library's `drafts/`, recursively - the one generated tree removed as a unit rather
// than file by file, since a draft holds several layers at once and nothing ever reaps one a layer
// at a time. Strictly inside `drafts/`, so no caller can hand it the whole of it or another tree.
export async function deleteDraft(dataPath: string, target: string): Promise<void> {
  const drafts = path.join(dataPath, 'drafts');
  if (!containsPath(drafts, target) || path.resolve(target) === path.resolve(drafts)) {
    throw new AppError('IO_ERROR', `refusing to remove ${target}: not a draft under ${dataPath}`);
  }
  if (isStrayOriginal(target) || (await findOriginalsAnywhere(target)).length > 0) {
    throw new AppError('IO_ERROR', `refusing to remove ${target}: it holds an original`);
  }
  await rm(target, { recursive: true, force: true });
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
// so a root the app has no library for is left as the app found it.
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

// The copy a restore stages beside the catalogue before renaming it into place
// (§4.9), when the restore does not get that far. Named from the catalogue it is
// destined for, which is the whole guard: nothing else can be spelled that way.
export async function deleteRestoreStaging(dbPath: string, target: string): Promise<void> {
  if (!path.resolve(target).startsWith(`${path.resolve(dbPath)}.restoring-`)) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: not a restore staging file for ${dbPath}`);
  }
  await rm(target, { force: true });
}


// One of the two scratch directories an update downloads and unpacks into (DESIGN §23.3).
// Naming which, rather than passing a path, is what keeps `versions/` - the directory the
// app is running out of - out of reach whatever else goes wrong.
//
// That settles the leaf and not the root, which is the half worth checking: `home` is
// `BOWERBIRD_HOME`, and `path.resolve` on a relative one silently anchors it to this
// process's working directory rather than to anything the supervisor made. A leading `/`
// dropped from an env file would then recursively delete `download` and `staged` out of
// wherever the server happened to be started from.
export async function deleteUpdateStaging(home: string, which: 'download' | 'staged'): Promise<void> {
  if (!path.isAbsolute(home)) {
    throw new AppError('IO_ERROR', `refusing to remove ${which}: BOWERBIRD_HOME is not an absolute path (${home})`);
  }
  await rm(path.join(home, which), { recursive: true, force: true });
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
  if (isStrayOriginal(target)) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: it is an original`);
  }
  await rm(target, { force: true });
}

// A partial blob download, discarded on hash mismatch or cancel. Staged files
// live directly in the staging directory as `<photoId>.partial`, which no RAW is
// ever named, so both checks together cannot name an original.
export async function deleteStagedBlob(stagingDir: string, target: string): Promise<void> {
  if (path.dirname(path.resolve(target)) !== path.resolve(stagingDir) || !target.endsWith('.partial')) {
    throw new AppError('IO_ERROR', `refusing to delete ${target}: not a staged blob in ${stagingDir}`);
  }
  await rm(target, { force: true });
}

// The one deliberate deletion of an original: manual eviction (docs/replication.md
// §7.6). The confirmation is the safety argument - a listening peer verified
// possession moments ago and its copy hashed to exactly the recorded content
// hash - so it is checked here, at the deletion, rather than trusted from the
// caller. The replicated locations table alone never satisfies this: its rows are
// stale by construction, and two peers each trusting the other's row can destroy
// the last two copies concurrently (§7.2).
export async function deleteEvictedOriginal(
  rootPath: string,
  target: string,
  confirmation: BlobVerifyResponse,
  recordedHash: string | null,
): Promise<void> {
  if (!containsPath(rootPath, target)) {
    throw new AppError('IO_ERROR', `refusing to evict ${target}: outside the library root`);
  }
  if (recordedHash == null || !confirmation.held || confirmation.content_hash !== recordedHash) {
    throw new AppError('CONFLICT', `refusing to evict ${target}: no live confirmation of another verified copy`);
  }
  await unlink(target);
}

/**
 * The other deliberate deletion of an original: the cull giving a local copy back to a backup
 * folder (docs/replication.md §14.5).
 *
 * Its own function rather than an argument to the one above, because the safety argument is a
 * different one. A peer is *asked* whether it holds the bytes, and its yes is a promise it keeps
 * by refusing to evict its own copy at the same moment; a folder promises nothing and answers
 * nothing, so nobody is standing behind the backup's copy but this device. So this reads both
 * files, now, and refuses unless all three agree: the backup's bytes, this device's bytes, and the
 * hash the catalogue recorded for the photograph.
 *
 * Reading the local copy as well as the backup's is the half that is easy to argue away, and it is
 * the one that matters most. A copy that has rotted on this disk hashes to something the recorded
 * value does not match - and deleting it "because the backup has a good copy" would be correct
 * only if the backup's copy were of *this* file, which is exactly what the recorded hash is the
 * evidence for. Both reads cost a pass over two files per photograph, on an action that runs when
 * a disk is full and never in a hot path.
 */
export async function deleteBackedUpOriginal(
  rootPath: string,
  target: string,
  backupCopy: string,
  recordedHash: string,
): Promise<void> {
  if (!containsPath(rootPath, target)) {
    throw new AppError('IO_ERROR', `refusing to give up ${target}: outside the library root`);
  }
  if (!existsSync(backupCopy)) {
    throw new AppError('CONFLICT', `refusing to give up ${target}: the backup has no copy at ${backupCopy}`);
  }
  const onBackup = await contentHash(backupCopy);
  if (onBackup !== recordedHash) {
    throw new AppError('CONFLICT', `refusing to give up ${target}: the backup's copy hashes ${onBackup}`);
  }
  const here = await contentHash(target);
  if (here !== recordedHash) {
    throw new AppError('CONFLICT', `refusing to give up ${target}: this copy hashes ${here}, not ${recordedHash}`);
  }
  await unlink(target);
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

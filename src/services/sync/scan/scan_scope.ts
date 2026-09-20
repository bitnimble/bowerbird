import { isDirInScope, type LibraryScope } from '../../../utils/scope';

/**
 * What a stalled materialisation takes out of a scan's evidence (§7.4).
 *
 * A merged move the drain could not make is the one disagreement between
 * catalogue and disk this run must not read: the row says the new path, the file
 * is still at the old one, and that is indistinguishable from the photographer
 * having moved it back. Read as that, the reversal is stamped here and
 * replicated, undoing the move on every peer.
 *
 * **All four collections, which is why they are held out in one place.** Both
 * channels see it, and the bin channel's version is the worst of them: a merge
 * that *restores* a photograph takes the row out of the binned set while the file
 * is still at its old bin path, so a bin walk finds a file no row claims, cannot
 * pair it - the live-side removal that would have paired it is exactly what is
 * held back - and inserts it as a new photograph with a fresh id. That one
 * replicates, and two rows for one file is not something anything undoes (§1).
 */
export interface ScanEvidence<Photo extends { id: string }, File extends { relPath: string }> {
  dbPhotos: readonly Photo[];
  files: readonly File[];
  binned: readonly Photo[];
  binFiles: readonly File[];
}

export function withoutStalled<Photo extends { id: string }, File extends { relPath: string }>(
  evidence: ScanEvidence<Photo, File>,
  stalled: readonly { photoId: string; wasAt: string }[],
): ScanEvidence<Photo, File> {
  if (stalled.length === 0) return evidence;
  const heldBack = new Set(stalled.map((entry) => entry.photoId));
  const occupied = new Set(stalled.map((entry) => entry.wasAt));
  return {
    dbPhotos: evidence.dbPhotos.filter((photo) => !heldBack.has(photo.id)),
    files: evidence.files.filter((file) => !occupied.has(file.relPath)),
    binned: evidence.binned.filter((photo) => !heldBack.has(photo.id)),
    binFiles: evidence.binFiles.filter((file) => !occupied.has(file.relPath)),
  };
}

/**
 * Whether a shoot's folder was here and is not now.
 *
 * The one thing that justifies deleting a shoot, and every premise is required,
 * because that deletion replicates and a shoot's grave is final (§5.1): the name,
 * the description, the ordering, the banner and the whole subtree go on every
 * device and cannot come back.
 *
 * A folder is absent from a walk for four different reasons and only one of them
 * is "the photographer deleted it":
 *
 * - it carries an `excluded` rule, settable on any folder from the settings page;
 * - the library does not include subfolders, so no folder was walked at all;
 * - this device has never seen it - a replicated shoot whose folder its
 *   photographs have not arrived to make, or which holds none and so never gets
 *   one;
 * - it was deleted.
 *
 * The first two are `isDirInScope`, which is the same predicate the walk descends
 * by, so the question is asked with the answer the walk itself used. The third is
 * `folder_dev`, written the first time a scan sees a folder. Note what the same
 * absence does to the *photographs* under it: `is_missing`, a local flag anyone can
 * undo. Two conclusions of very different severity from one observation, which is
 * the asymmetry worth remembering here.
 */
export function wentAway(
  scope: LibraryScope,
  walked: ReadonlySet<string>,
  shoot: { folder_path: string; folder_dev: number | null },
): boolean {
  return isDirInScope(scope, shoot.folder_path) && shoot.folder_dev != null && !walked.has(shoot.folder_path);
}

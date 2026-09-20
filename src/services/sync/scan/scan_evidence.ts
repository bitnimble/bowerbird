import { existsSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { scanLibraryTree, type ScannedDir, type ScannedFile } from '../../../utils/scan';
import { isPathAllowed, type LibraryScope } from '../../../utils/scope';
import { shootContains } from '../../../utils/shoots';
import type { PhotoScanRepository, ScanDbPhoto } from '../../photos/scan/photo_scan_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import type { ScanReconciler } from './scan_reconciler';
import { detectRelocationsByIdentity, type ShootRelocation } from './scan_relocations';
import { withoutStalled } from './scan_scope';

const log = new Logger('scan');

/**
 * What a scoped run reconciles, in the two shapes its callers can know a change in.
 *
 * `paths` is what a filesystem event names: this file, that folder, and nothing is
 * said about anything beside them. `dirs` is what a poll pass sees on a filesystem
 * that delivers no events (§9.8) - a folder's mtime moved, so *something* in it
 * did - and it is reconciled by listing it against the rows sitting directly in it.
 */
export interface ScanScope {
  readonly paths?: readonly string[];
  readonly dirs?: readonly string[];
}

export interface CollectedEvidence {
  scope: LibraryScope;
  binned: readonly ScanDbPhoto[];
  dbPhotos: readonly ScanDbPhoto[];
  files: readonly ScannedFile[];
  dirs: readonly ScannedDir[];
  stalled: readonly { photoId: string; wasAt: string }[];
  followed: ReturnType<ScanReconciler['followBinRename']>;
  binRoot: string | null;
  binFolder: string | null;
  binFiles: readonly ScannedFile[];
  byIdentity: ShootRelocation[];
  onDisk: (folder: string) => boolean;
}

// A path can arrive both named and inside a listed folder; stat/hash it once.
function dedupeByPath(files: readonly ScannedFile[]): ScannedFile[] {
  return [...new Map(files.map((file) => [file.relPath, file])).values()];
}

/**
 * Whether a file under the bin is one this library still has any business with.
 *
 * The bin is walked with no exclusions at all, deliberately: an excluded folder's
 * binned frames are still binned, and the rows that hold them still have to be
 * matched against their files. But an *unclaimed* file whose restore path the
 * library no longer covers is a frame from a folder somebody removed - the rows
 * went with the folder and the files stayed (§4.7) - and importing it brings the
 * whole folder back as new photographs under new ids, which the removal's
 * tombstones do not name and every peer then receives.
 *
 * Held out of the walk rather than skipped at the import, because a file with no
 * row is one the unchanged test cannot answer for, so it would be opened and
 * hashed on every full scan from here on.
 *
 * The folder, not the file: every rule here is about where a thing sits, and the
 * hidden-segment one would otherwise strand a frame whose own name begins with a
 * dot, which the live walk imports quite happily - it filters on extension alone.
 */
function keepsItsBinFiles(
  scope: LibraryScope,
  binned: readonly ScanDbPhoto[],
  binRoot: string | null,
  files: readonly ScannedFile[],
): readonly ScannedFile[] {
  if (binRoot == null) return files;
  const claimed = new Set(binned.map((row) => row.file_path));
  return files.filter((file) => {
    if (claimed.has(file.relPath)) return true;
    const restoresTo = file.relPath.slice(binRoot.length + 1);
    const folder = restoresTo.lastIndexOf('/');
    return isPathAllowed(scope, folder < 0 ? '' : restoresTo.slice(0, folder));
  });
}



  export async function collectEvidence(
  dependencies: {
    photoScan: PhotoScanRepository;
    shoots: ShootsRepository;
    reconciler: ScanReconciler;
    pendingMoves: (libraryId: string) => readonly { photoId: string; wasAt: string }[];
  },
  input: {
    libraryId: string;
    library: Library;
    scope: LibraryScope;
    changedScope: ScanScope | undefined;
    scopePaths: readonly string[] | null;
    keepLease: () => void;
  },
): Promise<CollectedEvidence> {
  const { photoScan, shoots, reconciler, pendingMoves } = dependencies;
  const { libraryId, library, scope, changedScope, scopePaths, keepLease } = input;

    // The rows whose paths are not the live channel's business (§9.1.1). Read on
    // every run, scoped or not: without them an in-place binned file the
    // watcher reports is an unclaimed addition and inserts a second live row
    // every time anyone touches it.
    let binned: readonly ScanDbPhoto[] = photoScan.listBinnedForScan(libraryId);
    let dbPhotos: readonly ScanDbPhoto[];
    let files: readonly ScannedFile[];
    // The folders this run saw, and their identities: every one of them on a
    // full walk, and on a scoped run the ones the watcher named. A folder that
    // moved is in here under its new path either way, which is what lets §9.4.1
    // recognise it (including one holding no photos, whose move nothing else
    // leaves a trace of).
    let dirs: readonly ScannedDir[];
    if (changedScope != null) {
      // Reconcile the changed paths themselves against their rows, plus the
      // missing move-source pool. The watcher names both halves of a move
      // (§9.8), so a rename arrives as its own removal and addition; the pool is
      // what pairs them when they land in different windows.
      const named = changedScope.paths ?? [];
      // A polled folder is reconciled by what is in it now against what is
      // recorded directly in it, which is the only way to see a removal that
      // nothing named: `listed.dirs` is what was actually read, so a folder that
      // could not be opened keeps its rows rather than losing them all to a diff
      // that saw an empty directory.
      const listed = await reconciler.listDirs(scope, changedScope.dirs ?? []);
      files = dedupeByPath([...reconciler.scopedFiles(scope, named), ...listed.files]);
      dbPhotos = reconciler.scopedDbPhotos(libraryId, named, listed.dirs);
      dirs = await reconciler.scopedDirs(scope, scopePaths ?? []);
    } else {
      dbPhotos = photoScan.listForScan(libraryId);
      ({ files, dirs } = await scanLibraryTree(scope, '', keepLease));
    }

    // A merged move the drain above could not make - a file the editor holds
    // open, a full disk - is the one disagreement between catalogue and disk that
    // this run must not read (docs/replication.md §7.4). The row says the new
    // path and the file is still at the old one, which is indistinguishable from
    // the photographer having moved it back; taken as that, the reversal is
    // stamped here and replicated, undoing a folder rename on every peer. So the
    // photograph and the path it still occupies are both held out of the diff,
    // and the next run tries the move again.
    // Held out of all four of this run's inputs by `withoutStalled`, which is
    // where the reasoning lives. The bin walk has not happened yet, so it is
    // filtered again where it lands, below.
    const stalled = pendingMoves(libraryId);
    if (stalled.length > 0) {
      ({ dbPhotos, files, binned } = withoutStalled({ dbPhotos, files, binned, binFiles: [] }, stalled));
      log.warn('some photographs are still waiting to be moved where a merge put them', {
        library: libraryId,
        photos: stalled.length,
      });
    }

    // A hand-renamed bin folder is the worst outcome in this design if it goes
    // unnoticed: the live walk would take its files as unclaimed additions
    // whose hashes match the binned rows exactly, and every binned row would
    // pair as a crossing *out* of the bin - the whole bin restored,
    // `deleted_from_path` destroyed, every undo batch unresolvable. Detected
    // here, immediately after the walk and before `scanFiles`, or the run
    // re-hashes the whole bin and then partitions on paths that match nothing.
    const followed = reconciler.followBinRename(library, dirs, binned);
    for (const under of followed.exclude) {
      files = files.filter((file) => !shootContains(under, file.relPath));
      // And out of `dirs` too, or a shoot folder the photographer had earlier
      // moved into the bin gets relocated into the renamed bin by identity.
      dirs = dirs.filter((dir) => dir.relPath !== under && !shootContains(under, dir.relPath));
    }

    // Whole-folder moves the inode can prove are resolved before the diff, not
    // after it: an **in-place** binned row's file sits in the live tree (§12.1) and
    // moved with the folder, so a rename would leave its recorded path stale
    // while the file at the new path read as an unclaimed live addition - one
    // duplicate per in-place binned photograph. The identity needs only `dirs`
    // and the shoots, both of which are already in hand.
    //
    // The photo-evidence fallback below cannot come this early, and does not
    // need to: it only fires when the move minted a new inode, where the binned
    // file is a genuinely new file too.
    const onDisk = (folder: string): boolean => existsSync(path.join(library.root_path, folder));
    const byIdentity = detectRelocationsByIdentity(shoots.listIdentities(libraryId), dirs, onDisk);
    for (const r of byIdentity) {
      for (const row of binned) {
        if (shootContains(r.oldFolderPath, row.file_path)) {
          row.file_path = r.newFolderPath + row.file_path.slice(r.oldFolderPath.length);
        }
      }
    }

    // The bin channel does not run on a scoped scan: the watcher never reports events inside
    // the bin, so a scoped run has no evidence and must not conclude
    // `is_missing` on rows it did not look at. The rename detection above is the
    // one exception - it is a `dirs` test and costs nothing.
    // Null when the bin was not walked at all, which is a different thing from
    // walking it and finding it empty: a run with no evidence must leave the
    // binned rows exactly as they are.
    const binScan = scopePaths == null && followed.root != null ? await reconciler.scanBinTree(library, followed.root, keepLease) : null;
    const binRoot = binScan == null ? null : followed.root;
    // Held out for the same reason the live walk's files are, and it has to
    // happen here because the bin is walked after that filter ran.
    const heldBack = withoutStalled({ dbPhotos: [], files: [], binned: [], binFiles: binScan ?? [] }, stalled);
    const binFiles = keepsItsBinFiles(scope, binned, binRoot, heldBack.binFiles);
    // What the bin is called after any rename this run followed, which is what
    // decides whether a binned row is in the bin or binned in place - a
    // different question from whether the bin was walked.
    const binFolder = followed.rename?.to ?? library.bin_name;

    return { scope, binned, dbPhotos, files, dirs, stalled, followed, binRoot, binFolder, binFiles, byIdentity, onDisk };
  
}

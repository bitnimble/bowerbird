import { existsSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { withNewId } from '../../../db/constraints';
import { Logger } from '../../../logger';
import { sequenceColumn } from '../../../schemas/capture_sequence';
import type { Library } from '../../../schemas/libraries';
import { importsFormat, scanLibraryTree, type ScannedDir, type ScannedFile } from '../../../utils/scan';
import { isDirInScope, isFileInScope, type LibraryScope } from '../../../utils/scope';
import { shootContains } from '../../../utils/shoots';
import type { LibrariesRepository } from '../../libraries/libraries_repository';
import { ensureBinFolder } from '../../libraries/bin_folder';
import type { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { PhotoScanRepository, ScanDbPhoto } from '../../photos/scan/photo_scan_repository';
import type { FolderRulesRepository } from '../../shoots/folder_rules_repository';
import type { ShootsRepository } from '../../shoots/shoots_repository';
import type { AddedEntry, Crossing, MoveResult } from './scan_diff';
import { findBinByIdentity } from './scan_relocations';
import { wentAway } from './scan_scope';

const log = new Logger('scan');

// Which shoots have to restate what they hold after mirroring made new ones, and
// in which order. A shoot's claim covers its whole subtree, so an ancestor's is a
// *superset* of its descendant's, not a duplicate of it: skipping the ancestor
// leaves the photographs sitting directly in that folder claimed by nobody, which
// nothing later repairs - the next scan has no new folders to react to. So every
// touched folder is issued, shallowest first, and the deeper claim lands last on
// the rows the two share.
//
// Only shoots at or under a newly created folder are in question at all; the rest
// of the library was already right, which is what keeps a library with nothing to
// mirror from rewriting a single row.
function claimsToRestate(created: readonly string[], byFolder: ReadonlyMap<string, string>): string[] {
  if (created.length === 0) return [];
  const isNew = new Set(created);

  // Walked by path segment rather than compared against every other folder:
  // mirroring creates as many folders as the library has, and "is any of these
  // under any of those" over both lists is quadratic in exactly the case this
  // runs in.
  const isTouched = (folder: string): boolean => {
    if (isNew.has(folder)) return true;
    let prefix = '';
    for (const segment of folder.split('/').slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      if (isNew.has(prefix)) return true;
    }
    return false;
  };

  return [...byFolder.keys()].filter(isTouched).sort((a, b) => a.split('/').length - b.split('/').length);
}

export class ScanReconciler {
  constructor(
    private readonly photoPaths: PhotoPathsRepository,
    private readonly photoMetadata: PhotoMetadataRepository,
    private readonly photoScan: PhotoScanRepository,
    private readonly libraries: LibrariesRepository,
    private readonly shoots: ShootsRepository,
    private readonly folderRules: FolderRulesRepository,
  ) {}


  // A file that entered or left the bin by hand (§9.1.1). The `channel` tags gave
  // the direction, so there is no position to test - which matters because an
  // in-place binned row is `is_deleted = 1` with its file outside the bin,
  // indistinguishable by position from a hand-restore.
  applyCrossing(crossing: Crossing, shootFor: (relPath: string) => string | null, binFolder: string | null): void {
    const wasBinned = this.photoMetadata.isBinned(crossing.photoId);
    if (crossing.direction === 'in') {
      this.photoPaths.setFilePath(crossing.photoId, crossing.newFilePath);
      // Already binned: a path update only. `markDeleted` would null
      // `deleted_batch` and drop the row out of its batch's undo. Otherwise
      // `shoot_id` is kept rather than nulled by the move's own
      // `setFilePathAndShoot`, matching what an app-driven binning does.
      if (!wasBinned) this.photoPaths.markDeleted(crossing.photoId, crossing.oldFilePath);
      return;
    }
    if (crossing.direction === 'out') {
      if (!wasBinned) return; // it was never in the bin; nothing to restore
      // **Leaving the bin is what restores a photograph, and a row binned in
      // place was never in it** - its file has simply been moved, which is not
      // the photographer saying they want it back. Position rather than the flag,
      // because the flag is what both of these rows have in common.
      if (binFolder == null || !shootContains(binFolder, crossing.oldFilePath)) {
        this.photoMetadata.moveBinnedInPlace(crossing.photoId, crossing.newFilePath);
        return;
      }
      this.photoPaths.markRestored(crossing.photoId, crossing.newFilePath);
      // `markRestored` does not touch `shoot_id`, and `reconcileShootFolders`
      // only restates claims under newly created folders - so without this the
      // photograph lands in the grid with no shoot for good.
      this.photoPaths.setShoot(crossing.photoId, shootFor(crossing.newFilePath));
      return;
    }
    this.photoPaths.setFilePath(crossing.photoId, crossing.newFilePath); // moved within the bin
  }


  // One new photo, at the shoot its path falls under. Returns its id, which the
  // run collects so a scoped one can hand the rendition batch its own photos.
  insertAdded(
    libraryId: string,
    entry: AddedEntry,
    shootId: string | null,
    addedAt: string,
    binned?: { deleted_from_path: string },
  ): string {
    return withNewId((id) =>
      this.photoScan.insertFromScan({
        id,
        binned,
        library_id: libraryId,
        shoot_id: shootId,
        file_hash: entry.fileHash,
        file_path: entry.filePath,
        width: entry.metadata.width,
        height: entry.metadata.height,
        orientation: entry.metadata.orientation,
        date_taken: entry.metadata.dateTaken,
        date_taken_offset: entry.metadata.dateTakenOffset,
        date_added: addedAt,
        date_updated: entry.metadata.mtime,
        file_size: entry.metadata.fileSize,
        latitude: entry.metadata.latitude,
        longitude: entry.metadata.longitude,
        iso: entry.metadata.iso,
        shutter_speed: entry.metadata.shutterSpeed,
        aperture: entry.metadata.aperture,
        focal_length: entry.metadata.focalLength,
        camera_make: entry.metadata.cameraMake,
        camera_model: entry.metadata.cameraModel,
        lens_model: entry.metadata.lensModel,
        capture_sequence: sequenceColumn(entry.metadata.sequence),
      }),
    );
  }


  // Brings the shoots into step with the folders the scan just saw (§9.4.1), and
  // records where each shoot's folder actually is: that is how the next rename
  // gets recognised, and a shoot created before the folder was ever scanned has
  // no identity until something writes one.
  reconcileShootFolders(
    library: Library,
    scope: LibraryScope,
    dirs: readonly ScannedDir[],
    presentFiles: ReadonlySet<string>,
    fullRun: boolean,
  ): number {
    const seen = new Map(dirs.map((d) => [d.relPath, d]));
    const seenPaths = new Set(seen.keys());
    const identities = this.shoots.listIdentities(library.id);
    const stale = identities.filter((identity) => {
      const dir = seen.get(identity.folder_path);
      return (
        dir != null &&
        (identity.folder_dev !== dir.dev || identity.folder_ino !== dir.ino || identity.folder_birthtime !== dir.birthtimeMs)
      );
    });

    const shoots = this.shoots.listFolders(library.id);
    const byPath = new Map(shoots.map((s) => [s.folder_path, s]));
    const plain = this.folderRules.pathsWithRule(library.id, 'plain');

    // A folder holding photographs of its own. Pass-through folders are left out:
    // they are structure rather than a set of photographs, and the tree on screen
    // is drawn from the shoots' own paths (§18.3.2).
    const withPhotos = new Set<string>();
    for (const file of presentFiles) {
      const slash = file.lastIndexOf('/');
      if (slash > 0) withPhotos.add(file.slice(0, slash));
    }
    const wanted: string[] = [];
    for (const folder of withPhotos) {
      if (!byPath.has(folder) && !plain.has(folder)) wanted.push(folder);
    }
    // Shallowest first, so each new shoot's parent already exists to be derived
    // from - the same derivation `create` uses.
    wanted.sort((a, b) => a.split('/').length - b.split('/').length);

    // A folder this device has walked at least once, which is what `folder_dev`
    // records. Deleting a shoot because its folder is missing is a statement about
    // the photographer removing that folder, and only a folder that was here can
    // have been removed: a shoot made here stats its folder as it is created, while
    // a replicated one carries NULL until a scan first sees a folder that may not
    // be made yet, or ever, its photographs being the only thing that would make
    // one. Read as a deletion, the absence tombstones the shoot back to every peer
    // - and a shoot's grave is final (§5.1), so the name, description, ordering and
    // banner go everywhere and cannot come back.
    const walkedFrom = new Map(identities.map((identity) => [identity.id, identity.folder_dev]));

    const doomed =
      fullRun
        ? shoots.filter((shoot) => {
            if (shoot.photo_count > 0) return false;
            if (!wentAway(scope, seenPaths, { folder_path: shoot.folder_path, folder_dev: walkedFrom.get(shoot.id) ?? null })) {
              return false;
            }
            // A shoot still holding a shoot is not empty, whatever its own count
            // says: `parent_id` cascades, so deleting it would take a descendant's
            // label, banner and its photos' membership with it, and those photos
            // are only "missing" in the sense that the whole subtree moved.
            return !shoots.some((other) => other.id !== shoot.id && shootContains(shoot.folder_path, other.folder_path));
          })
        : [];

    // Nothing to say: the overwhelmingly common scan. Skipped before opening a
    // transaction rather than inside one, so a quiet library costs a few map
    // lookups and no write lock at all.
    if (stale.length === 0 && wanted.length === 0 && doomed.length === 0) return 0;

    return this.shoots.transaction(() => {
      let changed = 0;
      for (const identity of stale) {
        const dir = seen.get(identity.folder_path)!;
        this.shoots.setIdentity(identity.id, dir.dev, dir.ino, dir.birthtimeMs);
      }

      // Keyed by folder so the enclosing shoot is a few lookups up the path
      // rather than a scan of every shoot per folder created, which was quadratic
      // in the folders a first mirroring scan makes.
      const byFolder = new Map(shoots.map((s) => [s.folder_path, s.id]));
      const enclosing = (folder: string): string | null => {
        const segments = folder.split('/');
        let prefix = '';
        let deepest: string | null = null;
        for (const segment of segments.slice(0, -1)) {
          prefix = prefix === '' ? segment : `${prefix}/${segment}`;
          deepest = byFolder.get(prefix) ?? deepest;
        }
        return deepest;
      };

      for (const folder of wanted) {
        const dir = seen.get(folder);
        const id = withNewId((candidate) =>
          this.shoots.insert({
            id: candidate,
            parent_id: enclosing(folder),
            library_id: library.id,
            folder_path: folder,
            name: folder.slice(folder.lastIndexOf('/') + 1),
            description: null,
            // No explicit choice was made, so the library's own answer is the
            // closest thing to one.
            ordering: library.ordering,
            folder_dev: dir?.dev ?? null,
            folder_ino: dir?.ino ?? null,
            folder_birthtime: dir?.birthtimeMs ?? null,
          }),
        );
        byFolder.set(folder, id);
        changed++;
      }

      // A new shoot takes the photographs in its folder, including any a shallower
      // shoot was holding for want of a closer one.
      for (const folder of claimsToRestate(wanted, byFolder)) {
        this.photoPaths.setShootForFolder(library.id, folder, byFolder.get(folder)!);
      }

      for (const shoot of doomed) {
        this.shoots.delete(shoot.id);
        changed++;
      }
      return changed;
    });
  }


  // The bin's own walk, over the bin alone (§9.1.1). `scanLibraryTree` with a start
  // directory rather than 45 forked lines of walk, which is also what keeps every
  // relPath library-root relative, as every path in the bin channel requires.
  //
  // A missing bin root is a **skip, not a throw**: the state §4.1 hands to §9.1.1
  // for repair is exactly one where the folder is briefly not where the columns
  // say, and a scan that dies there would make §4.1's safety argument circular.
  // Scoped to the bin, so an unreadable root still fails the run loudly rather
  // than reading as "the whole bin was deleted".
  async scanBinTree(library: Library, binRoot: string, keepLease: () => void): Promise<ScannedFile[] | null> {
    const abs = path.join(library.root_path, binRoot);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) {
      log.warn('the bin folder is not there; skipping the bin channel for this run', { library: library.id, bin: binRoot });
      // The walk is the only place with enough evidence to tell "deleted" from
      // "renamed", and it has just said deleted: remake it, and record the new
      // folder's identity, so the next rename is still followable.
      //
      // Not for a read-only library, which keeps the bin it had from before the
      // flag (§4.1) and is exactly the library whose photographer may have
      // deleted that folder on purpose. Making it again is a write under a root
      // this may not write to, and on a genuinely read-mounted volume it is an
      // error logged on every scan.
      if (!library.read_only) {
        await ensureBinFolder(library, this.libraries).catch((err: unknown) =>
          log.error('could not recreate the bin folder', { library: library.id, err }),
        );
      }
      return null;
    }
    // Everything under the bin is the bin's, so the walk descends unconditionally:
    // the bin rule would skip the very tree this is walking, the bin mirrors
    // folders even in a root-only library, an excluded folder's binned frames are
    // still binned, and a bin named with a leading dot is not a dotfolder to skip.
    // The formats are the library's, though: a photograph the live channel walks
    // past is not one the bin channel should find, or turning `include_non_raw`
    // off would drop the live rows and leave the binned ones reconciling forever.
    const inside: LibraryScope = {
      rootPath: library.root_path,
      includeSubfolders: true,
      includeNonRaw: library.include_non_raw,
      binName: null,
      excluded: new Set(),
    };
    const { files } = await scanLibraryTree(inside, binRoot, keepLease, () => true);
    return files;
  }


  // A photographer renaming `<root>/Bin` to `<root>/Rubbish` has done to the bin
  // what §9.4.1 already handles for a shoot, and it is answered the same way: by
  // the folder's inode identity (§9.1.1).
  //
  // The trigger is that identity turning up in `dirs`. A directory reaches `dirs`
  // only if the live walk did not skip it, and the walk skips by *name*, so a
  // directory carrying the recorded identity **is** the bin under a name that no
  // longer matches - including a case-only difference, where the recorded path
  // still resolves and no existence test would fire.
  followBinRename(
    library: Library,
    dirs: readonly ScannedDir[],
    binned: readonly ScanDbPhoto[],
  ): { root: string | null; rename: { from: string; to: string } | null; exclude: readonly string[] } {
    const none = { root: library.bin_name, rename: null, exclude: [] };
    const identity = this.libraries.getBinIdentity(library.id);
    if (library.bin_name == null) return none;

    const found = findBinByIdentity(dirs, identity);
    if (found.kind === 'none') return none;
    if (found.kind === 'ambiguous') {
      log.warn('the bin folder identity is ambiguous; skipping the bin channel for this run', {
        library: library.id,
        candidates: found.candidates,
      });
      // Every candidate, not just the first: each of them *is* the bin by
      // identity, and one left in the live walk is a second copy of the whole bin
      // imported as live photographs.
      return { root: null, rename: null, exclude: found.candidates };
    }
    const target = found.target;

    // Excluding is safe unconditionally; rewriting `bin_name` needs two more
    // conditions, because dropping the recorded-path absence test that
    // `detectRelocationsByIdentity` uses admits three false positives - a bind
    // mount of the bin elsewhere under the root, a hardlinked directory, and a
    // recycled inode - and following any of them would silently bin a real shoot.
    const recorded = statSync(path.join(library.root_path, library.bin_name), { throwIfNoEntry: false });
    // Not an existence test: on a case-insensitive filesystem the recorded path
    // still resolves, to the *same* inode, so a case-only rename is handled by
    // exclusion alone. Bind mounts and hardlinks die here too.
    if (recorded != null && recorded.dev === target.dev && recorded.ino === target.ino) {
      return { root: library.bin_name, rename: null, exclude: [target.relPath] };
    }
    // **The candidate has to hold one of them**, which is what tells a renamed bin
    // from a folder that merely inherited its freed inode number. Asked of the
    // candidate rather than of the rows: "does this library have anything in its
    // bin" is true of every library that has ever binned anything, and would let
    // the recycled inode through - the case this exists to refuse, and the one
    // that silently turns a real shoot into the bin.
    const from = library.bin_name;
    const claimed = binned.some(
      (row) =>
        shootContains(from, row.file_path) &&
        existsSync(path.join(library.root_path, target.relPath + row.file_path.slice(from.length))),
    );
    if (!claimed) {
      log.warn('a folder carries the bin identity but holds no binned file; not following it', {
        library: library.id,
        candidate: target.relPath,
      });
      // And **not excluded either**. Exclusion is unconditional only while the
      // candidate might be the bin; here it has just been shown not to be, and
      // dropping it from the live walk would mark a real shoot's photographs
      // missing - the same harm as following it, arrived at more quietly.
      return { root: library.bin_name, rename: null, exclude: [] };
    }

    // The in-memory rewrite is not deferred to the apply: the diff has to see
    // matched paths.
    for (const row of binned) {
      if (shootContains(from, row.file_path)) row.file_path = target.relPath + row.file_path.slice(from.length);
    }
    log.info('following a renamed bin folder', { library: library.id, from, to: target.relPath });
    return { root: target.relPath, rename: { from, to: target.relPath }, exclude: [target.relPath] };
  }


  // §9.1.1's path test, run before anything is imported: if `<bin>/A/c.arw` is
  // unclaimed and `A/c.arw` is an unpaired live removal, that **is** the crossing,
  // whatever the hashes say - the file may have been copied in and the original
  // deleted, or touched on the way. Without it that crossing produces a missing
  // live row *and* a second already-binned row for one frame.
  //
  // Returns the bin additions that are left, which are genuinely new.
  pairByPath(result: MoveResult, binRoot: string | null): AddedEntry[] {
    const binAdditions = result.added.filter((a) => a.channel === 'bin');
    if (binRoot == null || binAdditions.length === 0) return binAdditions;

    const removedByPath = new Map(result.removed.filter((r) => r.channel === 'live').map((r) => [r.filePath, r]));
    const claimed: AddedEntry[] = [];
    for (const addition of binAdditions) {
      const cameFrom = addition.filePath.slice(binRoot.length + 1);
      const removal = removedByPath.get(cameFrom);
      if (removal == null) continue;
      result.crossings.push({
        photoId: removal.photoId,
        oldFilePath: removal.filePath,
        newFilePath: addition.filePath,
        direction: 'in',
      });
      // Out of `removed` too, or `setMissing` fires on a row that just moved.
      result.removed = result.removed.filter((r) => r !== removal);
      claimed.push(addition);
    }
    result.added = result.added.filter((a) => !claimed.includes(a));
    return binAdditions.filter((a) => !claimed.includes(a));
  }


  // The rows a scoped scan reconciles: those at the changed + discovered paths
  // (candidates for remove/modify/reappear/add) plus every already-missing row (so
  // a new file can still hash-pair into a move across scans). Deduped by id.
  scopedDbPhotos(libraryId: string, knownPaths: readonly string[], listedDirs: readonly string[]): ScanDbPhoto[] {
    const byId = new Map<string, ScanDbPhoto>();
    for (const p of this.photoScan.listForScanByPaths(libraryId, knownPaths)) byId.set(p.id, p);
    for (const p of this.photoScan.listForScanInDirs(libraryId, listedDirs)) byId.set(p.id, p);
    for (const p of this.photoScan.listMissingForScan(libraryId)) byId.set(p.id, p);
    return [...byId.values()];
  }


  // The photographs sitting directly in each folder, and which of those folders
  // this actually got to read. Direct children only, because those are the rows
  // `scopedDbPhotos` pairs it against: descending would list files whose rows were
  // never fetched, and every one of them would read as an unclaimed addition.
  async listDirs(
    scope: LibraryScope,
    relDirs: readonly string[],
  ): Promise<{ files: ScannedFile[]; dirs: string[] }> {
    const files: ScannedFile[] = [];
    const dirs: string[] = [];
    for (const relDir of relDirs) {
      if (relDir !== '' && !isDirInScope(scope, relDir)) continue;
      const absDir = path.join(scope.rootPath, relDir);
      const entries = await readdir(absDir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
        // Gone is an answer: an empty listing against the rows recorded in it is
        // how a deleted folder becomes a folder of removals. Anything else means
        // the folder is still there and this run cannot see into it, so it says
        // nothing about it at all.
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
        log.warn('could not read a changed folder, leaving its photos as they are', { dir: absDir, err });
        return null;
      });
      if (entries == null) continue;
      dirs.push(relDir);
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (!importsFormat(scope, relPath) || !isFileInScope(scope, relPath)) continue;
        files.push({ relPath, absPath: path.join(absDir, entry.name) });
      }
    }
    return { files, dirs };
  }


  // Unique parent directories of the changed paths ('' = library root).
  scopeDirs(scopePaths: readonly string[]): string[] {
    const dirs = new Set<string>();
    for (const p of scopePaths) {
      const slash = p.lastIndexOf('/');
      dirs.add(slash < 0 ? '' : p.slice(0, slash));
    }
    return [...dirs];
  }


  // The identities of the folders a scoped run was told about: each changed path
  // that is itself a directory, plus the directories those paths sit in. The first
  // is what a folder move reports (an empty folder's move reports nothing else at
  // all), the second is what a file's move reports.
  async scopedDirs(scope: LibraryScope, scopePaths: readonly string[]): Promise<ScannedDir[]> {
    const candidates = new Set<string>(scopePaths);
    for (const dir of this.scopeDirs(scopePaths)) candidates.add(dir);
    const dirs: ScannedDir[] = [];
    for (const relPath of candidates) {
      if (relPath === '' || !isDirInScope(scope, relPath)) continue;
      const stats = await stat(path.join(scope.rootPath, relPath)).catch(() => null);
      if (stats?.isDirectory()) dirs.push({ relPath, dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs });
    }
    return dirs;
  }


  // The changed paths, as the files this library holds: anything of a format that
  // is not ours or that sits outside the scope (§9.1) is not one. Whether each is
  // still there is `scanFiles`' stat to make - a path that has gone yields nothing
  // there, so its row falls through to `removed`, and a path naming a directory is
  // dropped the same way.
  scopedFiles(scope: LibraryScope, scopePaths: readonly string[]): ScannedFile[] {
    return scopePaths
      .filter((relPath) => importsFormat(scope, relPath) && isFileInScope(scope, relPath))
      .map((relPath) => ({ relPath, absPath: path.join(scope.rootPath, relPath) }));
  }
}

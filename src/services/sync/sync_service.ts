import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library, LibrarySyncStatus } from '../../schemas/libraries';
import { isSupportedFile, scanLibraryTree, type ScannedDir, type ScannedFile } from '../../utils/scan';
import { isDirInScope, isFileInScope, libraryScope, type LibraryScope } from '../../utils/scope';
import { computeFileHash } from '../../utils/hash';
import { getDataPath } from '../../utils/paths';
import { shootContains } from '../../utils/shoots';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import type { PhotosRepository, SyncDbPhoto } from '../photos/photos_repository';
import type { FolderRulesRepository } from '../shoots/folder_rules_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import type { ProcessingScope } from '../processing/processing_service';
import {
  buildDiff,
  detectMoves,
  detectRelocationsByIdentity,
  detectShootRelocations,
  type AddedEntry,
  type DiskFile,
} from './sync_algorithm';
import { libraryMutex } from './library_mutex';
import { acquireSyncLock, releaseSyncLock } from './sync_lock';

export interface ProcessingTrigger {
  processUnprocessed(scope?: ProcessingScope, stopped?: () => boolean): void | Promise<void>;
}

// Unwinds a stopped scan whose partial result cannot be applied, which is any
// run that had rows to reconcile against (§9.10). Never leaves this module:
// syncLibrary turns it back into an idle status, because that run applied nothing.
class SyncCancelled extends Error {}

const log = new Logger('sync');

// How many photos a first scan holds before writing them down. Small enough that
// a kill costs seconds of work rather than hours, large enough that the commit
// itself is nowhere near the cost of the decodes that filled it.
const INSERT_BATCH = 1000;

// How often a running scan says where it has got to. A 300k-frame import is
// hours of work, and a log that says nothing until it finishes is
// indistinguishable from one that has hung.
const SCAN_PROGRESS_EVERY = 500;

// What the detached rendition batch a run hands off covers, kept so the status
// endpoint can report progress against the same set the batch is working on.
interface ProcessingBatch {
  queued: number;
  /** The run's own photos, or null when the batch covers the whole library. */
  photoIds: readonly string[] | null;
}

export type MetadataExtractor = (absPath: string) => Promise<FileMetadata>;

// Which shoots have to restate what they hold after mirroring made new ones, and
// in which order. A shoot's claim covers its whole subtree, so an ancestor's is a
// *superset* of its descendant's, not a duplicate of it: skipping the ancestor
// leaves the photographs sitting directly in that folder claimed by nobody, which
// nothing later repairs - the next sync has no new folders to react to. So every
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

type Status = LibrarySyncStatus['status'];

function idle(libraryId: string, status: Status = 'idle'): LibrarySyncStatus {
  return {
    library_id: libraryId,
    status,
    photos_to_scan: 0,
    photos_scanned: 0,
    photos_added: 0,
    photos_removed: 0,
    photos_moved: 0,
    photos_modified: 0,
    photos_processing: 0,
    photos_processed: 0,
  };
}

export class SyncService implements LibraryLifecycleListener {
  private readonly statuses = new Map<string, LibrarySyncStatus>();
  // What this library's current run queued for rendition building. Held so
  // getSyncStatus can report processed = queued - still-pending without any
  // background bookkeeping: the live pending count comes from the DB on read.
  private readonly processingBatch = new Map<string, ProcessingBatch>();
  // Identity token per in-flight sync generation, and the handle that stops it.
  // The lock is released before the detached processing runs, so a newer sync can
  // start while the old one's processing tail is still going; the token lets a
  // stale tail skip its status write instead of stomping the newer generation's.
  private readonly generation = new Map<string, AbortController>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly libraries: LibrariesRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly folderRules: FolderRulesRepository,
    private readonly processing: ProcessingTrigger,
    private readonly extract: MetadataExtractor = extractMetadata,
  ) {}

  // What this library contains, in the form the scan and the watcher both read
  // (§9.1). Built per run: a folder rule set between two syncs takes effect on
  // the next one without anything having to invalidate a cache.
  scopeFor(library: Library): LibraryScope {
    return libraryScope(library, getDataPath(library), this.folderRules.pathsWithRule(library.id, 'excluded'));
  }

  onLibraryCreated(_library: Library): void {
    // No action: sync is triggered on demand (POST /sync) or by the watcher.
  }

  // Drop the deleted library's in-memory status/generation so those maps don't
  // grow unbounded across create/delete cycles (mirrors the watcher's teardown).
  onLibraryDeleted(libraryId: string): void {
    this.generation.get(libraryId)?.abort(); // its rows are cascade-gone; finish nothing
    this.statuses.delete(libraryId);
    this.generation.delete(libraryId);
    this.processingBatch.delete(libraryId);
  }

  async syncAll(): Promise<void> {
    for (const library of this.libraries.list()) {
      try {
        await this.syncLibrary(library.id);
      } catch (err) {
        // Never let one library abort the batch (§9.7): skip locked ones silently,
        // log anything else, and move on to the remaining libraries.
        if (!(err instanceof AppError && err.code === 'SYNC_IN_PROGRESS')) {
          log.error('library failed during syncAll', { library: library.id, err });
        }
      }
    }
  }

  // A full sync (scopePaths omitted) walks the whole tree. A scoped sync (from the
  // watcher) reconciles only the given changed paths against their DB rows plus the
  // already-missing move-source pool, cheap, and move-detection still resolves a
  // relocation because both the removed old path and the added new path land in one
  // debounce batch, or pair across syncs via the missing pool (§9.3). The periodic
  // full sync (syncAll) is the backstop for events the watcher dropped.
  async syncLibrary(libraryId: string, scopePaths?: readonly string[]): Promise<LibrarySyncStatus> {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

    log.info('sync start', {
      library: libraryId,
      root: library.root_path,
      mode: scopePaths == null ? 'full' : 'scoped',
      paths: scopePaths?.length,
    });
    const startedAt = Date.now();
    const lockPath = acquireSyncLock(library.root_path);
    const token = new AbortController();
    this.generation.set(libraryId, token);
    let syncedStatus: LibrarySyncStatus | null = null;
    // The photos this run created or rewrote, for a scoped run to hand its
    // rendition batch. Null once the run is a full one, whose batch is the
    // library's whole backlog.
    let processingIds: readonly string[] | null = null;
    try {
      // Inside the mutex, outside the file lock: file lock first keeps sync-vs-sync
      // fail-fast (409), while the mutex makes file-moving mutations queue behind
      // this scan instead of invalidating its snapshot mid-flight.
      const synced = await libraryMutex.run(libraryId, async () => {
      this.statuses.set(libraryId, idle(libraryId, 'scanning'));

      // The scan is the long half of an import, and the status endpoint is the
      // only thing that can say so while it runs. No generation guard: the sync
      // lock is not released until after the scan, so nothing newer can exist.
      const reportScan = (scanned: number, toScan: number): void => {
        this.statuses.set(libraryId, { ...idle(libraryId, 'scanning'), photos_to_scan: toScan, photos_scanned: scanned });
        if (scanned > 0 && scanned % SCAN_PROGRESS_EVERY === 0) {
          log.info('scanning', { library: libraryId, scanned, of: toScan, ms: Date.now() - startedAt });
        }
      };
      // Read before the scan rather than after it: a first scan places its photos
      // as it goes, so it needs the shoots up front. The mutex holds them still
      // for the whole run (§9.9). A shoot relocation would rewrite these paths
      // mid-run, but that takes existing photos to move, and a first scan has none.
      const shoots = this.shoots.listFolders(libraryId);
      // A photo's shoot is the deepest of its ancestor folders that has one, so
      // it is a handful of map lookups rather than a walk of every shoot. With a
      // shoot per folder the walk was 20,000 comparisons per photo, which is
      // minutes of blocked event loop across a large import.
      const byFolder = new Map(shoots.map((s) => [s.folder_path, s.id]));
      const shootFor = (relPath: string): string | null => {
        const segments = relPath.split('/');
        let prefix = '';
        let deepest: string | null = null;
        for (const segment of segments.slice(0, -1)) {
          prefix = prefix === '' ? segment : `${prefix}/${segment}`;
          deepest = byFolder.get(prefix) ?? deepest;
        }
        return deepest;
      };

      // Only a scoped run collects them: a full run hands its batch the library
      // rather than a list, and a 300k-frame import has no reason to hold every
      // id it created.
      const touched: string[] | null = scopePaths != null ? [] : null;
      const insertPhoto = (entry: AddedEntry, addedAt: string): void => {
        const id = this.insertAdded(libraryId, entry, shootFor(entry.filePath), addedAt);
        touched?.push(id);
      };
      let added = 0;
      // A first scan writes its photos down in batches instead of holding the lot
      // until the end (§9.4). Its whole diff is additions - there are no rows for
      // a removal to be an absence from, and no move can pair without one - so
      // each batch is true on its own, whatever the scan goes on to find. That is
      // what makes a 300k-frame import survive a kill: it resumes at the batch it
      // reached, where a single closing transaction would have lost every hour of
      // it. Only a run with no rows qualifies; against a populated library an
      // addition can still turn out to be the far half of a move.
      const insertBatch = (batch: readonly DiskFile[]): void => {
        // Same re-check as the closing transaction: the library can be deleted
        // mid-scan, and its photos are then cascade-gone. Nothing awaits between
        // here and the (synchronous) transaction, so the delete cannot interleave.
        if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
        const batchAt = new Date().toISOString();
        this.photos.transaction(() => {
          for (const file of batch) {
            insertPhoto({ filePath: file.filePath, fileHash: file.hash, metadata: file.metadata }, batchAt);
          }
        });
        added += batch.length;
      };

      const scope = this.scopeFor(library);
      let dbPhotos: SyncDbPhoto[];
      let files: readonly ScannedFile[];
      // The folders this run saw, and their identities: every one of them on a
      // full walk, and on a scoped run the ones the watcher named. A folder that
      // moved is in here under its new path either way, which is what lets §9.4.1
      // recognise it (including one holding no photos, whose move nothing else
      // leaves a trace of).
      let dirs: readonly ScannedDir[];
      if (scopePaths != null) {
        // Reconcile only the changed paths' directories against the rows at the
        // changed + discovered paths, plus the missing move-source pool. Reading
        // whole directories rather than single files is what catches the other
        // half of a move whose two events did not land in the same window.
        files = await this.scopedFiles(scope, this.scopeDirs(scopePaths));
        const known = new Set<string>(scopePaths);
        for (const f of files) known.add(f.relPath);
        dbPhotos = this.scopedDbPhotos(libraryId, [...known]);
        dirs = await this.scopedDirs(scope, scopePaths);
      } else {
        dbPhotos = this.photos.listForSync(libraryId);
        ({ files, dirs } = await scanLibraryTree(scope));
      }
      const { present, changed, failed } = await this.scanFiles(
        files,
        dbPhotos,
        token.signal,
        reportScan,
        dbPhotos.length === 0 ? insertBatch : null,
      );
      log.info('scan done', {
        library: libraryId,
        files: present.size,
        rows: dbPhotos.length,
        // The files whose stat changed, so the scan opened and hashed them; the
        // rest cost a stat each. This is what a slow scan's time went on.
        opened: changed.length + added,
        unreadable: failed.size,
        ms: Date.now() - startedAt,
      });

      const diff = buildDiff(dbPhotos, present, changed, failed);
      const result = detectMoves(diff, (id) => this.albums.getAlbumIdsForPhoto(id).length > 0);

      // Whole-folder moves are resolved before anything per-photo. A shoot folder
      // renamed outside the app shows up as one move per frame it holds, and
      // relocating the shoot answers all of them at once: the photos keep their
      // position inside the folder, so their paths shift by a prefix and their
      // shoot membership does not change at all. What is left is the moves that
      // are genuinely about individual files.
      //
      // The inode answers first and exactly (§9.4.1); the photos answer the cases
      // it cannot see, which is any move that minted a new inode - across a
      // filesystem, or a whole library restored from a backup.
      const onDisk = (folder: string): boolean => existsSync(path.join(library.root_path, folder));
      const byIdentity = detectRelocationsByIdentity(this.shoots.listIdentities(libraryId), dirs, onDisk);
      const settled = new Set(byIdentity.map((r) => r.shootId));
      const claimed = new Set(byIdentity.map((r) => r.newFolderPath));
      const relocations = [
        ...byIdentity,
        // Two shoots cannot occupy one folder, so a guess at a folder the inode
        // has already spoken for is wrong by construction.
        ...detectShootRelocations(
          shoots.filter((s) => !settled.has(s.id)),
          result.moves,
          dbPhotos,
          onDisk,
        ).filter((r) => !claimed.has(r.newFolderPath)),
      ]
        // Deepest first, because each one rewrites its whole subtree by prefix.
        // Rename a folder and its child in one window and applying the parent
        // first would move the child's photos to a path the child's own rewrite
        // then fails to match, leaving rows pointing at a file that is not there
        // while `is_missing` still reads 0.
        .sort((a, b) => b.oldFolderPath.split('/').length - a.oldFolderPath.split('/').length);
      const relocatedFolders = relocations.map((r) => r.oldFolderPath);
      const moves = result.moves.filter((mv) => !relocatedFolders.some((folder) => shootContains(folder, mv.oldFilePath)));

      // shootFor has to read the post-relocation paths, or every relocated photo
      // would be tested against a folder its shoot no longer claims.
      for (const r of relocations) {
        for (const shoot of shoots) {
          if (shoot.folder_path === r.oldFolderPath) shoot.folder_path = r.newFolderPath;
          else if (shootContains(r.oldFolderPath, shoot.folder_path)) {
            shoot.folder_path = r.newFolderPath + shoot.folder_path.slice(r.oldFolderPath.length);
          }
        }
      }
      if (relocations.length > 0) {
        byFolder.clear();
        for (const shoot of shoots) byFolder.set(shoot.folder_path, shoot.id);
      }
      const nowUtc = new Date().toISOString();

      let removed = 0;
      // The relocated photos moved too, they were just answered in bulk.
      let moved = result.moves.length - moves.length;
      let modified = 0;

      // The library can be deleted during the (async) scan above; its photos are
      // then cascade-gone and inserting against the dead library_id would raise an
      // FK violation. Re-check here, no await between this and the synchronous
      // transaction, so the delete can't interleave, and abort cleanly.
      if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

      this.photos.transaction(() => {
        // First, so the per-photo work below is only ever the remainder.
        for (const r of relocations) {
          this.shoots.relocate(r.shootId, r.oldFolderPath, r.newFolderPath);
          this.photos.rewritePathPrefix(libraryId, r.oldFolderPath, r.newFolderPath);
        }
        for (const mv of moves) {
          this.photos.setFilePathAndShoot(mv.photoId, mv.newFilePath, shootFor(mv.newFilePath));
          moved++;
        }
        for (const md of result.modified) {
          this.photos.applyModification(md.photoId, {
            file_hash: md.newHash,
            width: md.metadata.width,
            height: md.metadata.height,
            orientation: md.metadata.orientation,
            date_taken: md.metadata.dateTaken,
            date_taken_offset: md.metadata.dateTakenOffset,
            date_updated: md.metadata.mtime,
            file_size: md.metadata.fileSize,
            latitude: md.metadata.latitude,
            longitude: md.metadata.longitude,
            iso: md.metadata.iso,
            shutter_speed: md.metadata.shutterSpeed,
            aperture: md.metadata.aperture,
            focal_length: md.metadata.focalLength,
            camera_make: md.metadata.cameraMake,
            camera_model: md.metadata.cameraModel,
            lens_model: md.metadata.lensModel,
          });
          touched?.push(md.photoId);
          modified++;
        }
        for (const ad of result.added) {
          insertPhoto(ad, nowUtc);
          added++;
        }
        for (const photoId of diff.reappeared) {
          this.photos.clearMissing(photoId);
          // A photo that went missing before its renditions were built is skipped
          // by the queue while it is missing (§9.4 step 4), so the sync that
          // brings it back is the one that owes them. Left out of a scoped run's
          // batch it would sit there unbuilt until the daily full sync.
          touched?.push(photoId);
        }
        for (const rm of result.removed) {
          // Skips if a concurrent rename/move relocated the photo during the scan
          // (its file_path no longer matches what we scanned); it isn't missing.
          const marked = this.photos.setMissing(rm.photoId, rm.filePath);
          if (marked && !rm.wasMissing) removed++; // per-sync delta only (§9.4 step 5)
        }
      });

      // After the photos are written, so the folders' contents are settled: which
      // folders hold photographs is the whole question mirroring answers.
      const mirrored = this.reconcileShootFolders(library, dirs, present, scopePaths == null);

      // Survives a restart, unlike the in-memory status, so the UI can always say
      // how stale the catalogue is (§9.6).
      this.libraries.setLastSyncedAt(libraryId, nowUtc);

      // A scoped run answers for the files it reconciled and nothing else: the
      // watcher fires on one changed file, and draining the library's whole
      // backlog off the back of that is not what the change asked for. A full run
      // is the one that does clear the backlog, which is how work a killed
      // process left behind gets picked up (§9.5).
      processingIds = touched;

      // Read after the transaction commits, so rows this sync inserted/modified
      // are counted (§9.6). This is the denominator for processing progress.
      const queued = this.photos.countPendingProcessing(libraryId, processingIds ?? undefined);
      this.processingBatch.set(libraryId, { queued, photoIds: processingIds });

      const status: LibrarySyncStatus = {
        library_id: libraryId,
        status: 'processing',
        photos_to_scan: present.size,
        photos_scanned: present.size,
        photos_added: added,
        photos_removed: removed,
        photos_moved: moved,
        photos_modified: modified,
        photos_processing: queued,
        photos_processed: 0,
      };
      this.statuses.set(libraryId, status);
      log.info('sync done', {
        library: libraryId,
        added,
        removed,
        moved,
        relocatedShoots: relocations.length,
        mirroredShoots: mirrored,
        modified,
        reappeared: diff.reappeared.length,
        queuedForProcessing: queued,
        ms: Date.now() - startedAt,
      });
      return status;
      });
      syncedStatus = synced;
      return synced;
    } catch (err) {
      // Scan/apply threw (e.g. root unmounted, DB error): reset status so the API
      // doesn't report 'scanning' forever. Still our generation here (the lock,
      // released in finally, blocks a newer one), but guard for consistency.
      if (this.generation.get(libraryId) === token) this.statuses.set(libraryId, idle(libraryId));
      // Stopped mid-scan on a populated library, where the writes are one closing
      // transaction: nothing was applied and the library is simply idle again.
      // Not an error - the caller asked for it. syncedStatus stays null, so no
      // processing runs.
      if (err instanceof SyncCancelled) {
        log.info('sync stopped', { library: libraryId, ms: Date.now() - startedAt });
        return idle(libraryId);
      }
      // A library deleted mid-scan is a normal end for this run, not a fault.
      if (err instanceof AppError && err.code === 'NOT_FOUND') log.info('sync abandoned: library deleted', { library: libraryId });
      else log.error('sync failed', { library: libraryId, ms: Date.now() - startedAt, err });
      throw err;
    } finally {
      // Release the lock as soon as scan+apply is done. Rendition generation runs
      // detached (§9.5/§9.6: background work, client polls status), so POST /sync
      // returns promptly and re-syncs aren't blocked for the whole processing run.
      releaseSyncLock(lockPath);
      if (syncedStatus != null) {
        const finalStatus = syncedStatus;
        // Runs on both success and failure: processing throwing must not leave the
        // status stuck at 'processing'. Skipped if a newer sync generation started
        // meanwhile, so a stale tail can't stomp the newer run's status.
        const scope: ProcessingScope = { libraryId, photoIds: processingIds ?? undefined };
        const settle = (): void => {
          if (this.generation.get(libraryId) !== token) return;
          const stillPending = this.photos.countPendingProcessing(libraryId, scope.photoIds);
          const processed = Math.max(0, finalStatus.photos_processing - stillPending);
          this.statuses.set(libraryId, {
            ...finalStatus,
            status: 'idle',
            photos_processing: stillPending,
            photos_processed: processed,
          });
          // Only when there was something to build: a sync that queued nothing
          // still settles, and saying so every time the watcher fires buries the
          // runs that are doing work.
          if (finalStatus.photos_processing > 0) {
            log.info('processing settled', { library: libraryId, processed, stillPending, ms: Date.now() - startedAt });
          }
        };
        // Asks about whichever generation is current rather than about this one:
        // a batch is per library and outlives the sync that started it, so a later
        // sync coalescing into it must not leave the stop button pointing at a run
        // nothing is doing any more.
        const stopped = (): boolean => this.generation.get(libraryId)?.signal.aborted === true;
        void Promise.resolve(this.processing.processUnprocessed(scope, stopped))
          .then(settle)
          .catch((err) => {
            log.error('processing failed', { library: libraryId, err });
            settle();
          });
      }
    }
  }

  // Stops the library's current run, wherever it has got to. A scan abandons its
  // work (nothing is applied), and processing stops handing out jobs, leaving the
  // photos it never reached pending for the next sync to pick up. Both settle
  // back to idle on their own; there is nothing to wait for here.
  cancelSync(libraryId: string): void {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    log.info('stop requested', { library: libraryId });
    this.generation.get(libraryId)?.abort();
  }

  // While rendition building runs (detached, §9.5), the counts are computed live from the
  // DB rather than pushed from the worker pool: one COUNT per poll, no cross-thread
  // progress plumbing.
  getSyncStatus(libraryId: string): LibrarySyncStatus {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const status = this.statuses.get(libraryId);
    // Nothing in memory: this process has not synced the library. The flags a
    // killed process left behind are still in the rows, though, so report what is
    // outstanding rather than a flat zero - the catalogue really does owe that
    // many renditions. Reading it starts nothing; a sync is still what picks the
    // work up (§9.6).
    if (status == null) {
      return { ...idle(libraryId), photos_processing: this.photos.countPendingProcessing(libraryId) };
    }
    if (status.status !== 'processing') return status;

    const batch = this.processingBatch.get(libraryId);
    const stillPending = this.photos.countPendingProcessing(libraryId, batch?.photoIds ?? undefined);
    const queued = batch?.queued ?? stillPending;
    return { ...status, photos_processing: stillPending, photos_processed: Math.max(0, queued - stillPending) };
  }

  // One new photo, at the shoot its path falls under. Returns its id, which the
  // run collects so a scoped one can hand the rendition batch its own photos.
  private insertAdded(libraryId: string, entry: AddedEntry, shootId: string | null, addedAt: string): string {
    const id = randomUUID();
    this.photos.insertFromSync({
      id,
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
    });
    return id;
  }

  // Brings the shoots into step with the folders the scan just saw (§9.4.1).
  //
  // Runs for every library, mirroring or not, because recording where each shoot's
  // folder actually is has nothing to do with the setting: it is how the next
  // rename gets recognised, and a shoot created before the folder was ever scanned
  // has no identity until something writes one.
  private reconcileShootFolders(
    library: Library,
    dirs: readonly ScannedDir[],
    presentFiles: ReadonlySet<string>,
    fullRun: boolean,
  ): number {
    const seen = new Map(dirs.map((d) => [d.relPath, d]));
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
    const plain = library.mirror_shoots ? this.folderRules.pathsWithRule(library.id, 'plain') : new Set<string>();

    // A folder holding photographs of its own. Pass-through folders are left out:
    // they are structure rather than a set of photographs, and the tree on screen
    // is drawn from the shoots' own paths (§18.3.2).
    const wanted: string[] = [];
    if (library.mirror_shoots) {
      const withPhotos = new Set<string>();
      for (const file of presentFiles) {
        const slash = file.lastIndexOf('/');
        if (slash > 0) withPhotos.add(file.slice(0, slash));
      }
      for (const folder of withPhotos) {
        if (!byPath.has(folder) && !plain.has(folder)) wanted.push(folder);
      }
      // Shallowest first, so each new shoot's parent already exists to be derived
      // from - the same derivation `create` uses.
      wanted.sort((a, b) => a.split('/').length - b.split('/').length);
    }

    const doomed =
      fullRun && library.mirror_shoots
        ? shoots.filter((shoot) => {
            if (seen.has(shoot.folder_path) || shoot.photo_count > 0) return false;
            // A shoot still holding a shoot is not empty, whatever its own count
            // says: `parent_id` cascades, so deleting it would take a descendant's
            // label, banner and its photos' membership with it, and those photos
            // are only "missing" in the sense that the whole subtree moved.
            return !shoots.some((other) => other.id !== shoot.id && shootContains(shoot.folder_path, other.folder_path));
          })
        : [];

    // Nothing to say: the overwhelmingly common sync. Skipped before opening a
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
      // in the folders a first mirroring sync makes.
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
        const shoot = {
          id: randomUUID(),
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
        };
        this.shoots.insert(shoot);
        byFolder.set(folder, shoot.id);
        changed++;
      }

      // A new shoot takes the photographs in its folder, including any a shallower
      // shoot was holding for want of a closer one.
      for (const folder of claimsToRestate(wanted, byFolder)) {
        this.photos.setShootForFolder(library.id, folder, byFolder.get(folder)!);
      }

      for (const shoot of doomed) {
        this.shoots.delete(shoot.id);
        changed++;
      }
      return changed;
    });
  }

  // The rows a scoped sync reconciles: those at the changed + discovered paths
  // (candidates for remove/modify/reappear/add) plus every already-missing row (so
  // a new file can still hash-pair into a move across syncs). Deduped by id.
  private scopedDbPhotos(libraryId: string, knownPaths: readonly string[]): SyncDbPhoto[] {
    const byId = new Map<string, SyncDbPhoto>();
    for (const p of this.photos.listForSyncByPaths(libraryId, knownPaths)) byId.set(p.id, p);
    for (const p of this.photos.listMissingForSync(libraryId)) byId.set(p.id, p);
    return [...byId.values()];
  }

  // Unique parent directories of the changed paths ('' = library root).
  private scopeDirs(scopePaths: readonly string[]): string[] {
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
  private async scopedDirs(scope: LibraryScope, scopePaths: readonly string[]): Promise<ScannedDir[]> {
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

  // readdir each scoped directory (non-recursive) for its current RAW files,
  // dropping non-RAW entries and anything out of the library's scope (§9.1). A
  // directory that's gone just yields nothing, so its DB rows fall through to
  // `removed`.
  private async scopedFiles(scope: LibraryScope, dirs: readonly string[]): Promise<ScannedFile[]> {
    const files: ScannedFile[] = [];
    for (const dir of dirs) {
      if (!isDirInScope(scope, dir)) continue;
      const absDir = path.join(scope.rootPath, dir);
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() || !isSupportedFile(entry.name)) continue;
        const relPath = dir ? `${dir}/${entry.name}` : entry.name;
        if (!isFileInScope(scope, relPath)) continue;
        files.push({ relPath, absPath: path.join(absDir, entry.name) });
      }
    }
    return files;
  }

  // Stats each file and opens/hashes ONLY the ones that are new or whose mtime+size
  // changed vs the stored record (§9.1). Unchanged files are never opened, so a
  // no-op sync does zero LibRaw work. Shared by the full and scoped paths.
  //
  // `onBatch`, when given, takes each run of INSERT_BATCH files as it is hashed
  // and is what makes a first scan resumable: a half-built `present` is normally
  // unusable, because absence from it is how a removal is detected, and applying
  // it would mark every file the scan had not reached as missing. With no rows
  // for it to be an absence from that cannot happen, and nothing else can either
  // - a move pairs a removal with an addition, and there are no removals - so
  // each batch says only "these files are new", which is true whether or not the
  // scan saw the rest. Those files are then handed over rather than accumulated,
  // so `changed` (and the diff built from it) stays empty.
  private async scanFiles(
    files: readonly ScannedFile[],
    dbPhotos: readonly SyncDbPhoto[],
    signal: AbortSignal,
    onProgress: (scanned: number, toScan: number) => void,
    onBatch: ((batch: readonly DiskFile[]) => void) | null,
  ): Promise<{ present: Set<string>; changed: DiskFile[]; failed: Set<string> }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

    // Stat everything, collapsing hardlink pairs (same dev+ino) to a single path.
    // A concurrent non-atomic move (moveIntoDir does link() then unlink()) briefly
    // exposes both the old and new path pointing at one inode; without this, the
    // new path would be scanned as a brand-new file and insertFromSync'd as a
    // permanent duplicate row. Prefer whichever path matches an existing record.
    type Scanned = { relPath: string; absPath: string; stats: Awaited<ReturnType<typeof stat>> };
    const byInode = new Map<string, Scanned>();
    for (const file of files) {
      if (signal.aborted) break;
      let stats;
      try {
        stats = await stat(file.absPath);
      } catch {
        continue; // vanished between readdir and stat: treat as not present (a race)
      }
      const key = `${stats.dev}:${stats.ino}`;
      const existing = byInode.get(key);
      if (existing == null || (!dbByPath.has(existing.relPath) && dbByPath.has(file.relPath))) {
        byInode.set(key, { relPath: file.relPath, absPath: file.absPath, stats });
      }
    }

    const present = new Set<string>();
    const changed: DiskFile[] = [];
    const failed = new Set<string>();
    const batch: DiskFile[] = [];
    const keep = (file: DiskFile): void => {
      if (onBatch == null) {
        changed.push(file);
        return;
      }
      batch.push(file);
      if (batch.length >= INSERT_BATCH) onBatch(batch.splice(0));
    };

    // The loop below is the whole cost of a scan (the stat pass above opens
    // nothing), so it is the one worth reporting against. `present` is added to
    // once per file, so its size is how many have been dealt with.
    for (const file of byInode.values()) {
      // Between files, not inside one: this is the loop that opens and hashes, so
      // a stop lands within one file's decode rather than at the end of the scan.
      if (signal.aborted) break;
      onProgress(present.size, byInode.size);
      present.add(file.relPath);

      const record = dbByPath.get(file.relPath);
      const unchanged =
        record != null && record.date_updated === file.stats.mtime.toISOString() && record.file_size === file.stats.size;
      if (unchanged) continue;

      try {
        const metadata = await this.extract(file.absPath);
        keep({ filePath: file.relPath, hash: computeFileHash(file.absPath, metadata), metadata });
      } catch (err) {
        // Unreadable/corrupt file: record it as failed so buildDiff leaves any
        // existing record untouched (not marked missing, and not falsely reappeared).
        failed.add(file.relPath);
        log.warn('unreadable file, left as it is', { file: file.absPath, err });
      }
    }

    // The tail of a batched scan, stopped or finished: it is as applicable as
    // every batch before it.
    if (batch.length > 0) onBatch?.(batch.splice(0));
    // Nothing was written down as it went, so a stop leaves the run with nothing
    // it can apply.
    if (signal.aborted && onBatch == null) throw new SyncCancelled();
    return { present, changed, failed };
  }
}

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Library, LibrarySyncStatus } from '../../schemas/libraries';
import { isSupportedFile, listSupportedFiles, type ScannedFile } from '../../utils/scan';
import { computeFileHash } from '../../utils/hash';
import { getDataPath } from '../../utils/paths';
import { mostSpecificShoot, shootContains } from '../../utils/shoots';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { LibraryLifecycleListener } from '../libraries/libraries_service';
import type { PhotosRepository, SyncDbPhoto } from '../photos/photos_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import { buildDiff, detectMoves, detectShootRelocations, type DiskFile } from './sync_algorithm';
import { libraryMutex } from './library_mutex';
import { acquireSyncLock, releaseSyncLock } from './sync_lock';

export interface ProcessingTrigger {
  processUnprocessed(libraryId?: string, stopped?: () => boolean): void | Promise<void>;
}

// Unwinds a stopped scan whose partial result cannot be applied (see
// `partialIsApplicable`). Never leaves this module: syncLibrary turns it back
// into an idle status, because that run applied nothing.
class SyncCancelled extends Error {}

export type MetadataExtractor = (absPath: string) => Promise<FileMetadata>;

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
  // Photos this library's current run queued for thumbnailing. Held so
  // getSyncStatus can report processed = queued - still-pending without any
  // background bookkeeping: the live pending count comes from the DB on read.
  private readonly queuedForProcessing = new Map<string, number>();
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
    private readonly processing: ProcessingTrigger,
    private readonly extract: MetadataExtractor = extractMetadata,
  ) {}

  onLibraryCreated(_library: Library): void {
    // No action: sync is triggered on demand (POST /sync) or by the watcher.
  }

  // Drop the deleted library's in-memory status/generation so those maps don't
  // grow unbounded across create/delete cycles (mirrors the watcher's teardown).
  onLibraryDeleted(libraryId: string): void {
    this.generation.get(libraryId)?.abort(); // its rows are cascade-gone; finish nothing
    this.statuses.delete(libraryId);
    this.generation.delete(libraryId);
    this.queuedForProcessing.delete(libraryId);
  }

  async syncAll(): Promise<void> {
    for (const library of this.libraries.list()) {
      try {
        await this.syncLibrary(library.id);
      } catch (err) {
        // Never let one library abort the batch (§9.7): skip locked ones silently,
        // log anything else, and move on to the remaining libraries.
        if (!(err instanceof AppError && err.code === 'SYNC_IN_PROGRESS')) {
          console.error(`syncAll: library ${library.id} failed: ${(err as Error).message}`);
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

    const lockPath = acquireSyncLock(library.root_path);
    const token = new AbortController();
    this.generation.set(libraryId, token);
    let syncedStatus: LibrarySyncStatus | null = null;
    try {
      // Inside the mutex, outside the file lock: file lock first keeps sync-vs-sync
      // fail-fast (409), while the mutex makes file-moving mutations queue behind
      // this scan instead of invalidating its snapshot mid-flight.
      const synced = await libraryMutex.run(libraryId, async () => {
      this.statuses.set(libraryId, idle(libraryId, 'scanning'));

      const dataPath = getDataPath(library);
      // The scan is the long half of an import, and the status endpoint is the
      // only thing that can say so while it runs. No generation guard: the sync
      // lock is not released until after the scan, so nothing newer can exist.
      const reportScan = (scanned: number, toScan: number): void => {
        this.statuses.set(libraryId, { ...idle(libraryId, 'scanning'), photos_to_scan: toScan, photos_scanned: scanned });
      };
      let dbPhotos: SyncDbPhoto[];
      let scan: { present: Set<string>; changed: DiskFile[]; failed: Set<string> };
      if (scopePaths != null) {
        // Bun's fs.watch delivers only one event for a rename (the old name), so
        // readdir the changed paths' directories to also discover the move target
        // (a sibling). Reconcile only those directories' current files against the
        // rows at the changed + discovered paths, plus the missing move-source pool.
        const files = await this.scopedFiles(library.root_path, dataPath, this.scopeDirs(scopePaths));
        const known = new Set<string>(scopePaths);
        for (const f of files) known.add(f.relPath);
        dbPhotos = this.scopedDbPhotos(libraryId, [...known]);
        scan = await this.scanFiles(files, dbPhotos, token.signal, reportScan);
      } else {
        dbPhotos = this.photos.listForSync(libraryId);
        const onDisk = await listSupportedFiles(library.root_path, dataPath);
        scan = await this.scanFiles(onDisk, dbPhotos, token.signal, reportScan);
      }
      const { present, changed, failed } = scan;
      const diff = buildDiff(dbPhotos, present, changed, failed);
      const result = detectMoves(diff, (id) => this.albums.getAlbumIdsForPhoto(id).length > 0);

      // Whole-folder moves are resolved before anything per-photo. A shoot folder
      // renamed outside the app shows up as one move per frame it holds, and
      // relocating the shoot answers all of them at once: the photos keep their
      // position inside the folder, so their paths shift by a prefix and their
      // shoot membership does not change at all. What is left is the moves that
      // are genuinely about individual files.
      const shoots = this.shoots.listByLibrary(libraryId);
      const relocations = detectShootRelocations(shoots, result.moves, dbPhotos, (folder) =>
        existsSync(path.join(library.root_path, folder)),
      );
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
      const shootFor = (relPath: string): string | null => mostSpecificShoot(relPath, shoots)?.id ?? null;
      const nowUtc = new Date().toISOString();

      let added = 0;
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
          modified++;
        }
        for (const ad of result.added) {
          this.photos.insertFromSync({
            id: randomUUID(),
            library_id: libraryId,
            shoot_id: shootFor(ad.filePath),
            file_hash: ad.fileHash,
            file_path: ad.filePath,
            width: ad.metadata.width,
            height: ad.metadata.height,
            orientation: ad.metadata.orientation,
            date_taken: ad.metadata.dateTaken,
            date_taken_offset: ad.metadata.dateTakenOffset,
            date_added: nowUtc,
            date_updated: ad.metadata.mtime,
            file_size: ad.metadata.fileSize,
            latitude: ad.metadata.latitude,
            longitude: ad.metadata.longitude,
            iso: ad.metadata.iso,
            shutter_speed: ad.metadata.shutterSpeed,
            aperture: ad.metadata.aperture,
            focal_length: ad.metadata.focalLength,
            camera_make: ad.metadata.cameraMake,
            camera_model: ad.metadata.cameraModel,
            lens_model: ad.metadata.lensModel,
          });
          added++;
        }
        for (const photoId of diff.reappeared) this.photos.clearMissing(photoId);
        for (const rm of result.removed) {
          // Skips if a concurrent rename/move relocated the photo during the scan
          // (its file_path no longer matches what we scanned); it isn't missing.
          const marked = this.photos.setMissing(rm.photoId, rm.filePath);
          if (marked && !rm.wasMissing) removed++; // per-sync delta only (§9.4 step 5)
        }
      });

      // Survives a restart, unlike the in-memory status, so the UI can always say
      // how stale the catalogue is (§9.6).
      this.libraries.setLastSyncedAt(libraryId, nowUtc);

      // Read after the transaction commits, so rows this sync inserted/modified
      // are counted (§9.6). This is the denominator for processing progress.
      const queued = this.photos.countPendingProcessing(libraryId);
      this.queuedForProcessing.set(libraryId, queued);

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
      return status;
      });
      syncedStatus = synced;
      return synced;
    } catch (err) {
      // Scan/apply threw (e.g. root unmounted, DB error): reset status so the API
      // doesn't report 'scanning' forever. Still our generation here (the lock,
      // released in finally, blocks a newer one), but guard for consistency.
      if (this.generation.get(libraryId) === token) this.statuses.set(libraryId, idle(libraryId));
      // Stopped mid-scan: every write is one transaction after the scan, so
      // nothing was applied and the library is simply idle again. Not an error -
      // the caller asked for it. syncedStatus stays null, so no processing runs.
      if (err instanceof SyncCancelled) return idle(libraryId);
      throw err;
    } finally {
      // Release the lock as soon as scan+apply is done. Thumbnail generation runs
      // detached (§9.5/§9.6: background work, client polls status), so POST /sync
      // returns promptly and re-syncs aren't blocked for the whole processing run.
      releaseSyncLock(lockPath);
      if (syncedStatus != null) {
        const finalStatus = syncedStatus;
        // Runs on both success and failure: processing throwing must not leave the
        // status stuck at 'processing'. Skipped if a newer sync generation started
        // meanwhile, so a stale tail can't stomp the newer run's status.
        const settle = (): void => {
          if (this.generation.get(libraryId) !== token) return;
          const stillPending = this.photos.countPendingProcessing(libraryId);
          this.statuses.set(libraryId, {
            ...finalStatus,
            status: 'idle',
            photos_processing: stillPending,
            photos_processed: Math.max(0, finalStatus.photos_processing - stillPending),
          });
        };
        // Asks about whichever generation is current rather than about this one:
        // a batch is per library and outlives the sync that started it, so a later
        // sync coalescing into it must not leave the stop button pointing at a run
        // nothing is doing any more.
        const stopped = (): boolean => this.generation.get(libraryId)?.signal.aborted === true;
        void Promise.resolve(this.processing.processUnprocessed(libraryId, stopped))
          .then(settle)
          .catch((err) => {
            console.error(`processing failed for library ${libraryId}: ${(err as Error).message}`);
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
    this.generation.get(libraryId)?.abort();
  }

  // While thumbnailing runs (detached, §9.5), the counts are computed live from the
  // DB rather than pushed from the worker pool: one COUNT per poll, no cross-thread
  // progress plumbing.
  getSyncStatus(libraryId: string): LibrarySyncStatus {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    const status = this.statuses.get(libraryId) ?? idle(libraryId);
    if (status.status !== 'processing') return status;

    const stillPending = this.photos.countPendingProcessing(libraryId);
    const queued = this.queuedForProcessing.get(libraryId) ?? stillPending;
    return { ...status, photos_processing: stillPending, photos_processed: Math.max(0, queued - stillPending) };
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

  // readdir each scoped directory (non-recursive) for its current RAW files,
  // dropping non-RAW, excluded-dir, and data-dir entries. A directory that's gone
  // just yields nothing, so its DB rows fall through to `removed`.
  private async scopedFiles(rootPath: string, dataPath: string, dirs: readonly string[]): Promise<ScannedFile[]> {
    const resolvedData = path.resolve(dataPath);
    const files: ScannedFile[] = [];
    for (const dir of dirs) {
      if (dir.split('/').some((s) => s.startsWith('.') || s === 'Bin')) continue;
      const absDir = path.join(rootPath, dir);
      let entries;
      try {
        entries = await readdir(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() || !isSupportedFile(entry.name)) continue;
        const absPath = path.join(absDir, entry.name);
        const resolved = path.resolve(absPath);
        if (resolved === resolvedData || resolved.startsWith(`${resolvedData}${path.sep}`)) continue;
        files.push({ relPath: dir ? `${dir}/${entry.name}` : entry.name, absPath });
      }
    }
    return files;
  }

  // Stats each file and opens/hashes ONLY the ones that are new or whose mtime+size
  // changed vs the stored record (§9.1). Unchanged files are never opened, so a
  // no-op sync does zero LibRaw work. Shared by the full and scoped paths.
  private async scanFiles(
    files: readonly ScannedFile[],
    dbPhotos: readonly SyncDbPhoto[],
    signal: AbortSignal,
    onProgress: (scanned: number, toScan: number) => void,
  ): Promise<{ present: Set<string>; changed: DiskFile[]; failed: Set<string> }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

    // What a stop costs, and the one case where it costs nothing (§9.10). A
    // half-built `present` is normally unusable, because absence from it is how a
    // removal is detected: applied, it would mark every file the scan had not
    // reached as missing. With no rows for it to be an absence from, that cannot
    // happen and nothing else can either - a move pairs a removal with an
    // addition, and there are no removals - so what a stopped scan holds is
    // exactly "these files are new", which is true whether or not it saw the rest.
    // That is the first import: the long scan, and the one worth stopping.
    const partialIsApplicable = dbPhotos.length === 0;

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
        changed.push({ filePath: file.relPath, hash: computeFileHash(file.absPath, metadata), metadata });
      } catch (err) {
        // Unreadable/corrupt file: record it as failed so buildDiff leaves any
        // existing record untouched (not marked missing, and not falsely reappeared).
        failed.add(file.relPath);
        console.error(`sync: could not read ${file.absPath}: ${(err as Error).message}`);
      }
    }

    // One decision for both loops: keep what a stopped scan found, or throw the
    // run away entirely.
    if (signal.aborted && !partialIsApplicable) throw new SyncCancelled();
    return { present, changed, failed };
  }
}

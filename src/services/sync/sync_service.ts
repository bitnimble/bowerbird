import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { AppError } from '../../errors';
import type { LibrarySyncStatus } from '../../schemas/libraries';
import { listSupportedFiles } from '../../utils/files';
import { computeFileHash } from '../../utils/hash';
import { getDataPath } from '../../utils/paths';
import { mostSpecificShoot } from '../../utils/shoots';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotosRepository, SyncDbPhoto } from '../photos/photos_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { extractMetadata, type FileMetadata } from '../processing/metadata';
import { buildDiff, detectMoves, type DiskFile } from './sync_algorithm';
import { acquireSyncLock, releaseSyncLock } from './sync_lock';

export interface ProcessingTrigger {
  processUnprocessed(libraryId?: string): void | Promise<void>;
}

export type MetadataExtractor = (absPath: string) => Promise<FileMetadata>;

type Status = LibrarySyncStatus['status'];

function idle(libraryId: string, status: Status = 'idle'): LibrarySyncStatus {
  return {
    library_id: libraryId,
    status,
    photos_scanned: 0,
    photos_added: 0,
    photos_removed: 0,
    photos_moved: 0,
    photos_modified: 0,
    photos_processing: 0,
    photos_processed: 0,
  };
}

export class SyncService {
  private readonly statuses = new Map<string, LibrarySyncStatus>();
  // Identity token per in-flight sync generation. The lock is released before the
  // detached processing runs, so a newer sync can start while the old one's
  // processing tail is still going; the token lets a stale tail skip its status
  // write instead of stomping the newer generation's status.
  private readonly generation = new Map<string, object>();

  constructor(
    private readonly photos: PhotosRepository,
    private readonly libraries: LibrariesRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly processing: ProcessingTrigger,
    private readonly extract: MetadataExtractor = extractMetadata,
  ) {}

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

  async syncLibrary(libraryId: string): Promise<LibrarySyncStatus> {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

    const lockPath = acquireSyncLock(library.root_path);
    const token = {};
    this.generation.set(libraryId, token);
    let syncedStatus: LibrarySyncStatus | null = null;
    try {
      this.statuses.set(libraryId, idle(libraryId, 'scanning'));

      const dbPhotos = this.photos.listForSync(libraryId);
      const { present, changed, failed } = await this.scan(library.root_path, getDataPath(library), dbPhotos);
      const diff = buildDiff(dbPhotos, present, changed, failed);
      const result = detectMoves(diff, (id) => this.albums.getAlbumIdsForPhoto(id).length > 0);

      const shoots = this.shoots.listByLibrary(libraryId);
      const shootFor = (relPath: string): string | null => mostSpecificShoot(relPath, shoots)?.id ?? null;
      const nowUtc = new Date().toISOString();

      let added = 0;
      let removed = 0;
      let moved = 0;
      let modified = 0;

      // The library can be deleted during the (async) scan above; its photos are
      // then cascade-gone and inserting against the dead library_id would raise an
      // FK violation. Re-check here, no await between this and the synchronous
      // transaction, so the delete can't interleave, and abort cleanly.
      if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

      this.photos.transaction(() => {
        for (const mv of result.moves) {
          this.photos.applyMove(mv.photoId, mv.newFilePath, shootFor(mv.newFilePath));
          moved++;
        }
        for (const md of result.modified) {
          this.photos.applyModification(md.photoId, {
            file_hash: md.newHash,
            width: md.metadata.width,
            height: md.metadata.height,
            orientation: md.metadata.orientation,
            date_taken: md.metadata.dateTaken,
            date_updated: md.metadata.mtime,
            file_size: md.metadata.fileSize,
            latitude: md.metadata.latitude,
            longitude: md.metadata.longitude,
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
            date_added: nowUtc,
            date_updated: ad.metadata.mtime,
            file_size: ad.metadata.fileSize,
            latitude: ad.metadata.latitude,
            longitude: ad.metadata.longitude,
          });
          added++;
        }
        for (const rp of diff.reappeared) this.photos.clearMissing(rp.photoId);
        for (const rm of result.removed) {
          // Skips if a concurrent rename/move relocated the photo during the scan
          // (its file_path no longer matches what we scanned); it isn't missing.
          const marked = this.photos.setMissing(rm.photoId, rm.filePath);
          if (marked && !rm.wasMissing) removed++; // per-sync delta only (§9.4 step 5)
        }
      });

      const status: LibrarySyncStatus = {
        library_id: libraryId,
        status: 'processing',
        photos_scanned: present.size,
        photos_added: added,
        photos_removed: removed,
        photos_moved: moved,
        photos_modified: modified,
        photos_processing: 0,
        photos_processed: 0,
      };
      this.statuses.set(libraryId, status);
      syncedStatus = status;
      return status;
    } finally {
      // Release the lock as soon as scan+apply is done. Thumbnail generation runs
      // detached (§9.5/§9.6: background work, client polls status), so POST /sync
      // returns promptly and re-syncs aren't blocked for the whole processing run.
      releaseSyncLock(lockPath);
      if (syncedStatus != null) {
        const finalStatus = syncedStatus;
        void Promise.resolve(this.processing.processUnprocessed(libraryId))
          .then(() => {
            // Skip if a newer sync generation started meanwhile, don't stomp its status.
            if (this.generation.get(libraryId) === token) this.statuses.set(libraryId, { ...finalStatus, status: 'idle' });
          })
          .catch((err) => console.error(`processing failed for library ${libraryId}: ${(err as Error).message}`));
      }
    }
  }

  getSyncStatus(libraryId: string): LibrarySyncStatus {
    if (!this.libraries.getById(libraryId)) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    return this.statuses.get(libraryId) ?? idle(libraryId);
  }

  // Lists every supported file (readdir + stat only) and opens/hashes ONLY the
  // ones that are new or whose mtime+size changed vs the stored record (§9.1).
  // Unchanged files are never opened, so a no-op sync does zero LibRaw work.
  private async scan(
    rootPath: string,
    dataPath: string,
    dbPhotos: readonly SyncDbPhoto[],
  ): Promise<{ present: Set<string>; changed: DiskFile[]; failed: Set<string> }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));
    const files = await listSupportedFiles(rootPath, dataPath);

    // Stat everything, collapsing hardlink pairs (same dev+ino) to a single path.
    // A concurrent non-atomic move (moveIntoDir does link() then unlink()) briefly
    // exposes both the old and new path pointing at one inode; without this, the
    // new path would be scanned as a brand-new file and insertFromSync'd as a
    // permanent duplicate row. Prefer whichever path matches an existing record.
    type Scanned = { relPath: string; absPath: string; stats: Awaited<ReturnType<typeof stat>> };
    const byInode = new Map<string, Scanned>();
    for (const file of files) {
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

    for (const file of byInode.values()) {
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

    return { present, changed, failed };
  }
}

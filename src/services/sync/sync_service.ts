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
    try {
      this.statuses.set(libraryId, idle(libraryId, 'scanning'));

      const dbPhotos = this.photos.listForSync(libraryId);
      const { present, changed } = await this.scan(library.root_path, getDataPath(library), dbPhotos);
      const diff = buildDiff(dbPhotos, present, changed);
      const result = detectMoves(diff, (id) => this.albums.getAlbumIdsForPhoto(id).length > 0);

      const shoots = this.shoots.listByLibrary(libraryId);
      const shootFor = (relPath: string): string | null => mostSpecificShoot(relPath, shoots)?.id ?? null;
      const nowUtc = new Date().toISOString();

      let added = 0;
      let removed = 0;
      let moved = 0;
      let modified = 0;

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
          this.photos.setMissing(rm.photoId);
          if (!rm.wasMissing) removed++; // per-sync delta only (§9.4 step 5)
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

      await this.processing.processUnprocessed(libraryId);

      const done = { ...status, status: 'idle' as const };
      this.statuses.set(libraryId, done);
      return done;
    } finally {
      releaseSyncLock(lockPath);
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
  ): Promise<{ present: Set<string>; changed: DiskFile[] }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));
    const files = await listSupportedFiles(rootPath, dataPath);
    const present = new Set<string>();
    const changed: DiskFile[] = [];

    for (const file of files) {
      let stats;
      try {
        stats = await stat(file.absPath);
      } catch {
        continue; // vanished between readdir and stat: treat as not present (a race)
      }
      present.add(file.relPath);

      const record = dbByPath.get(file.relPath);
      const unchanged =
        record != null && record.date_updated === stats.mtime.toISOString() && record.file_size === stats.size;
      if (unchanged) continue;

      try {
        const metadata = await this.extract(file.absPath);
        changed.push({ filePath: file.relPath, hash: computeFileHash(file.absPath, metadata), metadata });
      } catch (err) {
        // Unreadable/corrupt file: leave it in `present` (so an existing record is
        // preserved rather than marked missing) but skip indexing it this pass.
        console.error(`sync: could not read ${file.absPath}: ${(err as Error).message}`);
      }
    }

    return { present, changed };
  }
}

import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors';
import type { LibrarySyncStatus } from '../../schemas/libraries';
import { listSupportedFiles } from '../../utils/files';
import { computeFileHash } from '../../utils/hash';
import { getDataPath } from '../../utils/paths';
import { mostSpecificShoot } from '../../utils/shoots';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { PhotosRepository } from '../photos/photos_repository';
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
        if (err instanceof AppError && err.code === 'SYNC_IN_PROGRESS') continue; // another sync owns it
        throw err;
      }
    }
  }

  async syncLibrary(libraryId: string): Promise<LibrarySyncStatus> {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);

    const lockPath = acquireSyncLock(library.root_path);
    try {
      this.statuses.set(libraryId, idle(libraryId, 'scanning'));

      const diskFiles = await this.scan(library.root_path, getDataPath(library));
      const diff = buildDiff(this.photos.listForSync(libraryId), diskFiles);
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
        photos_scanned: diskFiles.length,
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

  private async scan(rootPath: string, dataPath: string): Promise<DiskFile[]> {
    const files = await listSupportedFiles(rootPath, dataPath);
    const diskFiles: DiskFile[] = [];
    for (const file of files) {
      const metadata = await this.extract(file.absPath);
      diskFiles.push({ filePath: file.relPath, hash: computeFileHash(file.absPath, metadata), metadata });
    }
    return diskFiles;
  }
}

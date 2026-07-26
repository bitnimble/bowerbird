import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Pagination } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';
import type { PhotoDetail, PhotoListQuery, PhotoListResponse, UpdatePhotoRequest } from '../../schemas/photos';
import { getBinPath, getOriginalPath, toLibraryRelative } from '../../utils/paths';
import { ensureDir, moveIntoDir } from '../../utils/files';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import { libraryMutex } from '../sync/library_mutex';
import type { PhotoListFilters, PhotoListResult, PhotosRepository } from './photos_repository';

function toFilters(query: PhotoListQuery): PhotoListFilters {
  return {
    includeDeleted: query.include_deleted,
    isMissing: query.is_missing,
    needsProcessing: query.needs_processing,
    isDeleted: query.is_deleted,
    rated: query.rated,
    triage: query.triage,
    search: query.q,
    takenFrom: query.taken_from,
    takenTo: query.taken_to,
    match: query.match,
  };
}

export class PhotosService {
  constructor(
    private readonly photos: PhotosRepository,
    private readonly albums: AlbumsRepository,
    private readonly shoots: ShootsRepository,
    private readonly libraries: LibrariesRepository,
  ) {}

  get(photoId: string): PhotoDetail {
    const photo = this.photos.getById(photoId);
    if (!photo) throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    return photo;
  }

  listByLibrary(libraryId: string, query: PhotoListQuery): PhotoListResponse {
    const library = this.libraries.getById(libraryId);
    if (!library) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    // The request's ordering wins over the collection's stored default, so a sort
    // control is a per-view choice rather than an edit to the library.
    return this.respond(
      this.photos.listByLibrary(libraryId, query.ordering ?? library.ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
    );
  }

  listMissing(libraryId: string, pagination: Pagination): PhotoListResponse {
    return this.listByLibrary(libraryId, {
      ...pagination,
      include_deleted: false,
      is_missing: true,
    });
  }

  listByShoot(shootId: string, query: PhotoListQuery): PhotoListResponse {
    const shoot = this.shoots.getById(shootId);
    if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
    return this.respond(
      this.photos.listByShoot(shootId, query.ordering ?? shoot.ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
    );
  }

  listByAlbum(albumId: string, query: PhotoListQuery): PhotoListResponse {
    const album = this.albums.getById(albumId);
    if (!album) throw new AppError('NOT_FOUND', `album not found: ${albumId}`);
    return this.respond(
      this.photos.listByAlbum(albumId, query.ordering ?? album.ordering, query.offset, query.limit, toFilters(query)),
      query.offset,
      query.limit,
    );
  }

  update(photoId: string, updates: UpdatePhotoRequest): PhotoDetail {
    if (!this.photos.update(photoId, updates)) {
      throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
    }
    return this.get(photoId);
  }

  // Soft-delete: move the RAW to a Bin and flag is_deleted (§12). Thumbnails are
  // deliberately KEPT: the Bin exists to be browsed and restored from, which is
  // impossible without them, and a WebP pair is ~1% of the RAW the Bin is already
  // holding. Each photo is isolated so one failure doesn't abandon the rest.
  async delete(photoIds: string[]): Promise<void> {
    const failures: string[] = [];
    for (const id of photoIds) {
      try {
        const photo = this.photos.getById(id);
        if (!photo || photo.is_deleted) continue;
        const library = this.libraries.getById(photo.library_id);
        if (!library) continue;

        // Queue behind any in-flight sync of this library: the Bin move would
        // otherwise invalidate its mid-scan snapshot.
        await libraryMutex.run(photo.library_id, async () => {
        const from = getOriginalPath(library, photo.file_path);
        let binRelPath: string | null = null;
        let movedToBin: string | null = null;
        if (existsSync(from)) {
          const binDir = this.binDir(library, photo.shoot_id);
          await ensureDir(binDir);
          const dest = await moveIntoDir(from, binDir, path.basename(photo.file_path));
          movedToBin = dest;
          binRelPath = toLibraryRelative(library.root_path, dest);
        }

        // Commit the Bin path and the deleted flag atomically: a crash between
        // them would otherwise leave an active photo whose file is in the Bin.
        try {
          this.photos.transaction(() => {
            if (binRelPath != null) this.photos.setFilePath(photo.id, binRelPath);
            this.photos.markDeleted(photo.id, photo.file_path);
          });
        } catch (dbErr) {
          // The DB write failed AFTER the file was moved into the Bin. Unlike the
          // shoot move-ops (whose destination is scanned, so a later sync
          // move-detects and self-heals), the Bin is excluded from scanning, so a
          // photo left is_deleted=0 with its file in the Bin is orphaned forever.
          // Move it back out so state stays consistent (as if delete never ran).
          if (movedToBin != null) {
            await moveIntoDir(movedToBin, path.dirname(from), path.basename(from)).catch((e) =>
              console.error(`failed to roll back Bin move for ${photo.id}: ${(e as Error).message}`),
            );
          }
          throw dbErr;
        }

        });
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new AppError('IO_ERROR', `failed to delete ${failures.length} photo(s): ${failures.join('; ')}`);
    }
  }

  // Undo of delete: move the RAW out of the Bin back to exactly where it was and
  // clear is_deleted (§12.3). Shoot and album membership are untouched by delete,
  // so they need no restoring; only the file and its path moved.
  async restore(photoIds: string[]): Promise<void> {
    const failures: string[] = [];
    for (const id of photoIds) {
      try {
        const photo = this.photos.getById(id);
        if (!photo || !photo.is_deleted) continue;
        const library = this.libraries.getById(photo.library_id);
        if (!library) continue;

        await libraryMutex.run(photo.library_id, async () => {
          const from = getOriginalPath(library, photo.file_path);
          if (!existsSync(from)) {
            throw new AppError('IO_ERROR', `the file is no longer in the Bin: ${photo.file_path}`);
          }

          // Pre-column rows have no recorded origin; the library root is the only
          // safe guess, and the next sync reconciles shoot membership from the path.
          const target = this.photos.getDeletedFromPath(id) ?? path.basename(photo.file_path);
          const destDir = path.dirname(getOriginalPath(library, target));
          await ensureDir(destDir);

          // Restores to the recorded name, or a suffixed one if something took
          // the path meanwhile, so a restore can never overwrite a live photo.
          const dest = await moveIntoDir(from, destDir, path.basename(target));
          this.photos.markRestored(id, toLibraryRelative(library.root_path, dest));
        });
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new AppError('IO_ERROR', `failed to restore ${failures.length} photo(s): ${failures.join('; ')}`);
    }
  }

  // Bin lives inside the shoot folder for shoot photos, else the library data dir.
  private binDir(library: Library, shootId: string | null): string {
    if (shootId) {
      const shoot = this.shoots.getById(shootId);
      if (shoot) return path.join(library.root_path, shoot.folder_path, 'Bin');
    }
    return getBinPath(library);
  }

  private respond(result: PhotoListResult, offset: number, limit: number): PhotoListResponse {
    return { photos: result.photos, total: result.total, offset, limit };
  }
}

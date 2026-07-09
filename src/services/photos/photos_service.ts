import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Pagination, ScopedListQuery } from '../../schemas/common';
import type { Library } from '../../schemas/libraries';
import type { PhotoDetail, PhotoListQuery, PhotoListResponse, UpdatePhotoRequest } from '../../schemas/photos';
import { getBinPath, getFullThumbnailPath, getOriginalPath, getSmallThumbnailPath, toLibraryRelative } from '../../utils/paths';
import { moveIntoDir } from '../../utils/files';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import type { PhotoListFilters, PhotoListResult, PhotosRepository } from './photos_repository';

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
    const filters: PhotoListFilters = {
      includeDeleted: query.include_deleted,
      isMissing: query.is_missing,
      needsProcessing: query.needs_processing,
    };
    return this.respond(
      this.photos.listByLibrary(libraryId, library.ordering, query.offset, query.limit, filters),
      query.offset,
      query.limit,
    );
  }

  listMissing(libraryId: string, pagination: Pagination): PhotoListResponse {
    return this.listByLibrary(libraryId, {
      ...pagination,
      include_deleted: false,
      is_missing: true,
      needs_processing: undefined,
    });
  }

  listByShoot(shootId: string, query: ScopedListQuery): PhotoListResponse {
    const shoot = this.shoots.getById(shootId);
    if (!shoot) throw new AppError('NOT_FOUND', `shoot not found: ${shootId}`);
    return this.respond(
      this.photos.listByShoot(shootId, shoot.ordering, query.offset, query.limit, { includeDeleted: query.include_deleted }),
      query.offset,
      query.limit,
    );
  }

  listByAlbum(albumId: string, query: ScopedListQuery): PhotoListResponse {
    const album = this.albums.getById(albumId);
    if (!album) throw new AppError('NOT_FOUND', `album not found: ${albumId}`);
    return this.respond(
      this.photos.listByAlbum(albumId, album.ordering, query.offset, query.limit, { includeDeleted: query.include_deleted }),
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

  getAlbumMemberships(photoId: string): string[] {
    return this.albums.getAlbumIdsForPhoto(photoId);
  }

  // Soft-delete: move the RAW to a Bin, flag is_deleted, then remove thumbnails
  // (§12). The Bin move happens before anything destructive, and each photo is
  // isolated so one failure neither abandons the rest of the batch nor leaves an
  // active photo with its thumbnails already gone.
  async delete(photoIds: string[]): Promise<void> {
    const failures: string[] = [];
    for (const id of photoIds) {
      try {
        const photo = this.photos.getById(id);
        if (!photo || photo.is_deleted) continue;
        const library = this.libraries.getById(photo.library_id);
        if (!library) continue;

        const from = getOriginalPath(library, photo.file_path);
        let binRelPath: string | null = null;
        if (existsSync(from)) {
          const binDir = this.binDir(library, photo.shoot_id);
          await this.ensureDir(binDir);
          const dest = await this.moveInto(from, binDir, path.basename(photo.file_path));
          binRelPath = toLibraryRelative(library.root_path, dest);
        }

        // Commit the Bin path and the deleted flag atomically: a crash between
        // them would otherwise leave an active photo whose file is in the Bin.
        this.photos.transaction(() => {
          if (binRelPath != null) this.photos.setFilePath(photo.id, binRelPath);
          this.photos.markDeleted(photo.id);
        });

        // Best-effort thumbnail cleanup: the photo is already flagged deleted, so
        // a stale thumbnail is harmless (endpoints 404 on deleted photos).
        await rm(getSmallThumbnailPath(library, photo.id), { force: true }).catch(() => {});
        await rm(getFullThumbnailPath(library, photo.id), { force: true }).catch(() => {});
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new AppError('IO_ERROR', `failed to delete ${failures.length} photo(s): ${failures.join('; ')}`);
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      throw new AppError('IO_ERROR', `failed to create directory ${dir}: ${(err as Error).message}`);
    }
  }

  private async moveInto(from: string, dir: string, filename: string): Promise<string> {
    try {
      return await moveIntoDir(from, dir, filename);
    } catch (err) {
      throw new AppError('IO_ERROR', `failed to move ${from} to Bin: ${(err as Error).message}`);
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

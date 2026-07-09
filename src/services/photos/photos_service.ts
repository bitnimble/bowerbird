import { AppError } from '../../errors';
import type { Pagination } from '../../schemas/common';
import type { PhotoDetail, PhotoListQuery, PhotoListResponse, UpdatePhotoRequest } from '../../schemas/photos';
import type { AlbumsRepository } from '../albums/albums_repository';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { ShootsRepository } from '../shoots/shoots_repository';
import type { PhotoListFilters, PhotoListResult, PhotosRepository } from './photos_repository';

export type ScopedListQuery = Pagination & { include_deleted: boolean };

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

  private respond(result: PhotoListResult, offset: number, limit: number): PhotoListResponse {
    return { photos: result.photos, total: result.total, offset, limit };
  }
}

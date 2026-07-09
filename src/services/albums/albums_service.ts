import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors';
import type { Album, CreateAlbumRequest, UpdateAlbumRequest } from '../../schemas/albums';
import type { PhotosRepository } from '../photos/photos_repository';
import type { AlbumsRepository } from './albums_repository';

export class AlbumsService {
  constructor(
    private readonly repo: AlbumsRepository,
    private readonly photos: PhotosRepository,
  ) {}

  create(request: CreateAlbumRequest): Album {
    const id = randomUUID();
    this.repo.insert({ id, name: request.name, ordering: request.ordering });
    return { id, name: request.name, ordering: request.ordering, banner_photo_id: null };
  }

  get(albumId: string): Album {
    const album = this.repo.getById(albumId);
    if (!album) throw new AppError('NOT_FOUND', `album not found: ${albumId}`);
    return album;
  }

  list(): Album[] {
    return this.repo.list();
  }

  addPhotos(albumId: string, photoIds: string[]): void {
    this.get(albumId);
    this.repo.addPhotos(albumId, photoIds, new Date().toISOString());
  }

  removePhotos(albumId: string, photoIds: string[]): void {
    this.get(albumId);
    this.repo.removePhotos(albumId, photoIds);
  }

  delete(albumId: string): void {
    if (!this.repo.delete(albumId)) throw new AppError('NOT_FOUND', `album not found: ${albumId}`);
  }

  update(albumId: string, updates: UpdateAlbumRequest): Album {
    this.get(albumId);
    this.repo.updateFields(albumId, { name: updates.name, ordering: updates.ordering });
    if ('banner_photo_id' in updates) {
      const bannerId = updates.banner_photo_id ?? null;
      // Validate up front: the banner FK would otherwise surface as a raw 500.
      // Albums aren't library-scoped (§4.4), so only existence is checked.
      if (bannerId != null && this.photos.getBasicByIds([bannerId]).length === 0) {
        throw new AppError('VALIDATION_ERROR', `banner photo not found: ${bannerId}`);
      }
      this.repo.setBanner(albumId, bannerId);
    }
    return this.get(albumId);
  }
}

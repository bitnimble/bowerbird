import { action, runInAction } from 'mobx';
import { ApiError, api, type Ordering } from '../../api/client';
import type { AlbumsStore } from './albums_store';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class AlbumsPresenter {
  constructor(private readonly store: AlbumsStore) {}

  async load(): Promise<void> {
    this.beginLoad();
    try {
      const albums = await api.listAlbums();
      runInAction(() => {
        this.store.albums = albums;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  async create(name: string, ordering: Ordering): Promise<boolean> {
    try {
      await api.createAlbum({ name, ordering });
    } catch (err) {
      this.fail(message(err));
      return false;
    }
    await this.load();
    return true;
  }

  async rename(albumId: string, name: string): Promise<void> {
    try {
      await api.updateAlbum(albumId, { name });
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  // How this album is sorted, which is the album's own property rather than a
  // per-browser preference, so it is the same wherever it is opened (§18.3.1).
  async setOrdering(albumId: string, ordering: Ordering): Promise<void> {
    try {
      await api.updateAlbum(albumId, { ordering });
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  async remove(albumId: string): Promise<void> {
    try {
      await api.deleteAlbum(albumId);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  // Called by PhotosPresenter for bulk actions (see ShootsPresenter.addPhotos).
  async addPhotos(albumId: string, photoIds: string[]): Promise<void> {
    await api.addPhotosToAlbum(albumId, photoIds);
  }

  async removePhotos(albumId: string, photoIds: string[]): Promise<void> {
    await api.removePhotosFromAlbum(albumId, photoIds);
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  @action.bound
  private beginLoad(): void {
    this.store.loading = true;
    this.store.error = null;
  }

  @action.bound
  private fail(error: string): void {
    this.store.loading = false;
    this.store.error = error;
  }
}

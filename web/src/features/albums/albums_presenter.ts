import { runInAction } from 'mobx';
import { type Album } from '../../../../src/schemas/albums';
import { type Ordering } from '../../../../src/schemas/common';
import { type PhotoTarget } from '../../../../src/schemas/photos';
import { albumsApi } from '../../api/albums';
import { ApiError } from '../../api/request';
import { CollectionListPresenter } from '../../app/collection_list_presenter';
import type { AlbumsStore } from './albums_store';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class AlbumsPresenter extends CollectionListPresenter<AlbumsStore> {
  async load(): Promise<void> {
    this.beginLoad();
    try {
      const albums = await albumsApi.list();
      runInAction(() => {
        this.store.albums = albums;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  async create(name: string, ordering: Ordering): Promise<string | null> {
    let album: Album;
    try {
      album = await albumsApi.create({ name, ordering });
    } catch (err) {
      this.fail(message(err));
      return null;
    }
    await this.load();
    return album.id;
  }

  protected override async renameRow(albumId: string, name: string): Promise<void> {
    await this.rename(albumId, name);
  }

  async rename(albumId: string, name: string): Promise<void> {
    try {
      await albumsApi.update(albumId, { name });
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
      await albumsApi.update(albumId, { ordering });
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  async remove(albumId: string): Promise<void> {
    try {
      await albumsApi.delete(albumId);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
    // The deleted album may have been the cursor.
    this.settleCursor();
  }

  // Called by PhotosPresenter for bulk actions (see ShootsPresenter.addPhotos).
  async addPhotos(albumId: string, target: PhotoTarget): Promise<void> {
    await albumsApi.addPhotos(albumId, target);
  }

  async removePhotos(albumId: string, target: PhotoTarget): Promise<void> {
    await albumsApi.removePhotos(albumId, target);
  }

  async setBanner(albumId: string, photoId: string): Promise<void> {
    await albumsApi.update(albumId, { banner_photo_id: photoId });
    await this.load();
  }
}

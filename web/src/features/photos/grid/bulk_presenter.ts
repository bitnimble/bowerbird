import { type PhotoTarget } from '../../../../../src/schemas/photos';
import { photosApi } from '../../../api/photos';
import { newId } from '../../../../../src/schemas/id';
import type { AlbumsPresenter } from '../../albums/albums_presenter';
import type { ShootsPresenter } from '../../shoots/shoots_presenter';
import type { ToastsPresenter } from '../../toasts/toasts_presenter';
import type { MarksStore } from './marks_store';
import { PhotosPresenterStrings } from '../photos_presenter.strings';
import { PhotoDetailStrings } from '../viewer/photo_detail_page.strings';

export class BulkPresenter {
  constructor(
    private readonly store: MarksStore,
    private readonly shoots: ShootsPresenter,
    private readonly albums: AlbumsPresenter,
    private readonly toasts: ToastsPresenter,
    private readonly selectionTarget: () => PhotoTarget | null,
    private readonly clearSelectedPositions: () => void,
    private readonly dropConsumedSelection: () => void,
    private readonly refresh: () => Promise<void>,
    private readonly refreshDetail: () => Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {}

  // --- bulk actions ---
  // Cross-domain writes go through the sibling presenter, never the sibling store.

  async addSelectedToShoot(shootId: string): Promise<void> {
    await this.bulk(
      (target) => this.shoots.addPhotos(shootId, target),
      PhotosPresenterStrings.movedIntoShoot,
    );
  }

  async addSelectedToAlbum(albumId: string): Promise<void> {
    await this.bulk(
      (target) => this.albums.addPhotos(albumId, target),
      PhotosPresenterStrings.addedToAlbum,
    );
  }

  async removeSelectedFromShoot(shootId: string): Promise<void> {
    await this.bulk(
      (target) => this.shoots.removePhotos(shootId, target),
      PhotosPresenterStrings.movedBackToLibraryRoot,
    );
  }

  async removeSelectedFromAlbum(albumId: string): Promise<void> {
    await this.bulk(
      (target) => this.albums.removePhotos(albumId, target),
      PhotosPresenterStrings.removedFromAlbum,
    );
  }

  // The selection's first photograph, not the whole of it: a collection has one
  // banner, and taking the first is what the menu row says it does. The selection
  // stays, since nothing about it was consumed.
  async setSelectionAsBanner(collection: { kind: 'shoot' | 'album'; id: string }): Promise<void> {
    const photoId = this.store.firstSelectedPhotoId;
    if (photoId == null) return;
    try {
      if (collection.kind === 'shoot') await this.shoots.setBanner(collection.id, photoId);
      else await this.albums.setBanner(collection.id, photoId);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.toasts.show(
      collection.kind === 'shoot'
        ? PhotosPresenterStrings.shootThumbnailSet()
        : PhotosPresenterStrings.albumThumbnailSet(),
    );
  }

  async deleteSelected(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    await this.deletePhotos(target);
  }

  async restoreSelected(): Promise<void> {
    await this.bulk((target) => photosApi.restore(target), PhotosPresenterStrings.restored);
  }

  /**
   * Puts photographs away, or brings them back (§12.4). Either way they leave the view they were
   * chosen in, so the collection is re-read rather than the rows patched.
   *
   * The count comes from the server for the reason a bin's does: a selection can name positions
   * that no longer hold a photograph.
   *
   * The open photograph's detail is re-read alongside the collection, which a bin does not need to
   * do: binning takes a photograph out of the viewer, where hiding is offered there as one row that
   * points whichever way the photograph is not. Left stale, that row keeps saying "Hide" for a
   * photograph already hidden, and the detail cache holds sixty-four of them - so the way back
   * would be gone for the rest of the session.
   */
  async hidePhotos(target: PhotoTarget, hidden: boolean): Promise<void> {
    let updated: number;
    try {
      updated = (await photosApi.hide(target, hidden)).updated;
    } catch (err) {
      this.fail(err);
      return;
    }
    this.clearSelectedPositions();
    await Promise.all([this.refresh(), this.refreshDetail()]);
    this.dropConsumedSelection();
    this.toasts.show(
      (hidden ? PhotosPresenterStrings.hidden : PhotosPresenterStrings.unhidden)(updated),
    );
  }

  async hideSelected(hidden: boolean): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    await this.hidePhotos(target, hidden);
  }

  async rebuildGridRenditions(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    await this.rebuildTiles(target);
    this.dropConsumedSelection();
  }

  async rebuildTiles(target: PhotoTarget): Promise<void> {
    try {
      const { queued } = await photosApi.rebuildTiles(target);
      await this.refreshDetail();
      // Re-read rather than left to the per-tile announcements: one that goes missing leaves its
      // tile stale until a reload.
      await this.refresh();
      this.toasts.show(PhotosPresenterStrings.rebuiltThumbnails(queued));
    } catch (err) {
      this.fail(err);
    }
  }

  // Binning is reversible, so it reports with an undo rather than asking first.
  // The batch is stamped on the rows the bin takes, and the undo names it: the
  // selection this was made from resolves to different photographs now that
  // these have left the collection, and the ids themselves are something neither
  // side should be carrying a million of (§12.3).
  async deletePhotos(target: PhotoTarget): Promise<void> {
    const batch = newId();
    let deleted: number;
    try {
      // How many it took, from the server: a selection can name positions that
      // no longer hold a photo, so the count on screen is not the answer.
      deleted = (await photosApi.delete(target, batch)).deleted;
    } catch (err) {
      this.fail(err);
      return;
    }
    this.clearSelectedPositions();
    await this.refresh();
    this.dropConsumedSelection();
    this.toasts.showUndoable(
      PhotosPresenterStrings.movedToBin(deleted),
      PhotoDetailStrings.undo(),
      async () => {
        await photosApi.restore({ batch });
        await this.refresh();
      },
    );
  }

  private async bulk(
    run: (target: PhotoTarget) => Promise<void>,
    success: (count: number) => string,
  ): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    const count = this.store.selectionCount;
    try {
      await run(target);
    } catch (err) {
      this.fail(err);
      return;
    }
    // The moves/deletes change what this collection contains, so re-read it
    // rather than patching rows locally and drifting from the server.
    this.clearSelectedPositions();
    await this.refresh();
    this.dropConsumedSelection();
    this.toasts.show(success(count));
  }
}

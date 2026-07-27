import { action, runInAction } from 'mobx';
import {
  ApiError,
  api,
  losslessUrl,
  type Ordering,
  type PhotoListParams,
  type PhotoListResponse,
  type ThumbnailSource,
  type Triage,
} from '../../api/client';
import { decodeLossless } from './lossless_image';
import type { AlbumsPresenter } from '../albums/albums_presenter';
import type { ShootsPresenter } from '../shoots/shoots_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { activeFilters, type PhotoFilters, type PhotoSource, type PhotosStore, type ViewMode } from './photos_store';
import { loadViewState, saveViewState } from './view_state';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function sourceLabel(source: ThumbnailSource): string {
  return source === 'embedded' ? 'embedded JPEG' : 'RAW render';
}

export class PhotosPresenter {
  // Only the newest list request may write to the store; an older one that
  // resolves late (slow page of a big library) would otherwise overwrite it.
  private inFlight: AbortController | null = null;

  constructor(
    private readonly store: PhotosStore,
    private readonly shoots: ShootsPresenter,
    private readonly albums: AlbumsPresenter,
    private readonly toasts: ToastsPresenter,
  ) {}

  async open(source: PhotoSource): Promise<void> {
    this.beginLoad(source);
    await this.fetchPage();
  }

  async reload(): Promise<void> {
    if (this.store.source == null) return;
    await this.fetchPage();
  }

  // --- view controls ---

  async setFilters(filters: PhotoFilters): Promise<void> {
    this.applyFilters(filters);
    await this.fetchPage();
  }

  async setOrdering(ordering: Ordering): Promise<void> {
    this.applyOrdering(ordering);
    await this.fetchPage();
  }

  @action.bound
  setThumbSize(px: number): void {
    this.store.thumbSize = px;
    this.remember();
  }

  @action.bound
  setMode(mode: ViewMode): void {
    this.store.mode = mode;
    this.remember();
  }

  // Sets a verdict straight from a grid tile, and pressing the verdict a photo
  // already has clears it, so one control covers all three states.
  async toggleTriage(photoId: string, verdict: Exclude<Triage, 'untriaged'>): Promise<void> {
    const photo = this.store.photos.find((p) => p.id === photoId) ?? this.store.detail;
    if (photo == null) return;
    await this.setTriage(photoId, photo.triage === verdict ? 'untriaged' : verdict);
  }

  async refreshMetadata(photoIds: string[]): Promise<void> {
    if (photoIds.length === 0) return;
    try {
      const { updated } = await api.refreshMetadata(photoIds);
      await this.refreshDetail();
      this.toasts.show(`Refreshed metadata for ${plural(updated, 'photo', 'photos')}`);
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
    }
  }

  async refreshMetadataForSelection(): Promise<void> {
    await this.refreshMetadata(this.store.selectedIds);
    this.clearSelection();
  }

  // Builds the full-resolution render if it does not exist yet, then decodes it
  // here: no browser reads JPEG XL natively, so the bytes have to be turned into
  // something an <img> accepts before anything can be shown.
  async showLossless(photoId: string): Promise<void> {
    runInAction(() => (this.store.buildingLossless = true));
    try {
      if (this.store.detail?.id === photoId && !this.store.detail.has_lossless) {
        await api.buildLossless(photoId);
        await this.refreshDetail();
      }
      const image = await decodeLossless(losslessUrl(photoId));
      runInAction(() => {
        this.store.lossless?.revoke();
        this.store.lossless = image;
      });
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
    } finally {
      runInAction(() => (this.store.buildingLossless = false));
    }
  }

  // Frees the object URL: a full-resolution PNG blob is hundreds of megabytes,
  // and leaving it attached keeps that alive for the life of the document.
  @action.bound
  hideLossless(): void {
    this.store.lossless?.revoke();
    this.store.lossless = null;
  }

  async goToPage(index: number): Promise<void> {
    this.setOffset(Math.max(0, Math.min(index, this.store.pageCount - 1)) * this.store.limit);
    await this.fetchPage();
  }

  async nextPage(): Promise<void> {
    if (this.store.hasNextPage) await this.goToPage(this.store.pageIndex + 1);
  }

  async prevPage(): Promise<void> {
    if (this.store.hasPrevPage) await this.goToPage(this.store.pageIndex - 1);
  }

  // --- detail ---

  async openDetail(photoId: string): Promise<void> {
    this.beginDetail();
    try {
      const detail = await api.getPhoto(photoId);
      runInAction(() => {
        this.store.detail = detail;
        this.store.detailLoading = false;
      });
      // Landing straight on a photo URL leaves no collection loaded, so the
      // neighbours are unknown and prev/next are dead. Open the photo's library
      // so stepping works from a deep link as well as from the grid.
      if (this.store.source == null) await this.open({ kind: 'library', libraryId: detail.library_id });
    } catch (err) {
      runInAction(() => {
        this.store.detailLoading = false;
        this.store.error = message(err);
      });
    }
  }

  async setRating(photoId: string, rating: number): Promise<void> {
    await this.patch(photoId, { rating });
  }

  async setTriage(photoId: string, triage: Triage): Promise<void> {
    await this.patch(photoId, { triage });
  }

  async setNotes(photoId: string, notes: string): Promise<void> {
    await this.patch(photoId, { notes });
    runInAction(() => (this.store.notesSavedAt = Date.now()));
  }

  // --- keyboard culling ---
  // These act on the focused tile, so the whole cull can happen in the grid
  // without opening each photo.

  @action.bound
  focusAt(index: number): void {
    if (this.store.photos.length === 0) return;
    this.store.focusIndex = Math.max(0, Math.min(index, this.store.photos.length - 1));
  }

  @action.bound
  moveFocus(delta: number): void {
    const from = this.store.focusIndex < 0 ? 0 : this.store.focusIndex + delta;
    this.focusAt(from);
  }

  async rateFocused(rating: number): Promise<void> {
    const photo = this.store.focusedPhoto;
    if (photo == null) return;
    await this.setRating(photo.id, rating);
  }

  async setFocusedTriage(triage: Triage): Promise<void> {
    const photo = this.store.focusedPhoto;
    if (photo == null) return;
    await this.setTriage(photo.id, triage);
  }

  async togglePickFocused(): Promise<void> {
    const photo = this.store.focusedPhoto;
    if (photo == null) return;
    // Pressing pick on an already-picked photo clears the verdict, so the same
    // key both sets and undoes it.
    await this.setTriage(photo.id, photo.triage === 'picked' ? 'untriaged' : 'picked');
  }

  async toggleRejectFocused(): Promise<void> {
    const photo = this.store.focusedPhoto;
    if (photo == null) return;
    await this.setTriage(photo.id, photo.triage === 'rejected' ? 'untriaged' : 'rejected');
  }

  async binFocused(): Promise<void> {
    const photo = this.store.focusedPhoto;
    if (photo == null || photo.is_deleted) return;
    await this.deletePhotos([photo.id]);
  }

  // --- selection ---

  @action.bound
  toggle(photoId: string): void {
    const next = new Set(this.store.selected);
    if (next.has(photoId)) next.delete(photoId);
    else next.add(photoId);
    this.store.selected = next;
    this.store.lastToggled = photoId;
  }

  // Shift-click selects everything between the last toggled photo and this one,
  // which is how you pick a burst without clicking forty times.
  @action.bound
  extendTo(photoId: string): void {
    const ids = this.store.photos.map((p) => p.id);
    const anchor = this.store.lastToggled == null ? -1 : ids.indexOf(this.store.lastToggled);
    const target = ids.indexOf(photoId);
    if (anchor < 0 || target < 0) {
      this.toggle(photoId);
      return;
    }
    const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
    const next = new Set(this.store.selected);
    for (const id of ids.slice(from, to + 1)) next.add(id);
    this.store.selected = next;
  }

  @action.bound
  selectAllOnPage(): void {
    this.store.selected = new Set(this.store.photos.map((p) => p.id));
  }

  @action.bound
  clearSelection(): void {
    this.store.selected = new Set();
    this.store.lastToggled = null;
  }

  // --- bulk actions ---
  // Cross-domain writes go through the sibling presenter, never the sibling store.

  async addSelectedToShoot(shootId: string): Promise<void> {
    const ids = this.store.selectedIds;
    await this.bulk(() => this.shoots.addPhotos(shootId, ids), `Moved ${plural(ids.length, 'photo', 'photos')} into the shoot`);
  }

  async addSelectedToAlbum(albumId: string): Promise<void> {
    const ids = this.store.selectedIds;
    await this.bulk(() => this.albums.addPhotos(albumId, ids), `Added ${plural(ids.length, 'photo', 'photos')} to the album`);
  }

  async removeSelectedFromShoot(shootId: string): Promise<void> {
    const ids = this.store.selectedIds;
    await this.bulk(
      () => this.shoots.removePhotos(shootId, ids),
      `Moved ${plural(ids.length, 'photo', 'photos')} back to the library root`,
    );
  }

  async removeSelectedFromAlbum(albumId: string): Promise<void> {
    const ids = this.store.selectedIds;
    await this.bulk(() => this.albums.removePhotos(albumId, ids), `Removed ${plural(ids.length, 'photo', 'photos')} from the album`);
  }

  async deleteSelected(): Promise<void> {
    await this.deletePhotos(this.store.selectedIds);
  }

  async restoreSelected(): Promise<void> {
    const ids = this.store.selectedIds;
    await this.bulk(() => api.restorePhotos(ids), `Restored ${plural(ids.length, 'photo', 'photos')}`);
  }

  async reprocessSelected(source: ThumbnailSource): Promise<void> {
    await this.reprocess(this.store.selectedIds, source);
    this.clearSelection();
  }

  // Rebuilding is queued server-side, so this reports that the work started
  // rather than that it finished; the grid picks up the new files as they land.
  async reprocess(photoIds: string[], source: ThumbnailSource): Promise<void> {
    if (photoIds.length === 0) return;
    try {
      const { queued } = await api.reprocessPhotos(photoIds, source);
      runInAction(() => (this.store.rebuiltAt = Date.now()));
      await this.refreshDetail();
      this.toasts.show(`Rebuilding ${plural(queued, 'thumbnail', 'thumbnails')} from the ${sourceLabel(source)}`);
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
    }
  }

  private async refreshDetail(): Promise<void> {
    const open = this.store.detail;
    if (open == null) return;
    const detail = await api.getPhoto(open.id).catch(() => null);
    if (detail != null) runInAction(() => (this.store.detail = detail));
  }

  // Binning is reversible, so it reports with an undo rather than asking first.
  async deletePhotos(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await api.deletePhotos(ids);
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
      return;
    }
    this.clearSelection();
    await this.fetchPage();
    this.toasts.showUndoable(`${plural(ids.length, 'photo', 'photos')} moved to the Bin`, 'Undo', async () => {
      await api.restorePhotos(ids);
      await this.fetchPage();
    });
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  private async bulk(run: () => Promise<void>, success: string): Promise<void> {
    if (this.store.selectedIds.length === 0) return;
    try {
      await run();
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
      return;
    }
    // The moves/deletes change what this collection contains, so re-read it
    // rather than patching rows locally and drifting from the server.
    this.clearSelection();
    await this.fetchPage();
    this.toasts.show(success);
  }

  private async patch(photoId: string, fields: Parameters<typeof api.updatePhoto>[1]): Promise<void> {
    try {
      const updated = await api.updatePhoto(photoId, fields);
      runInAction(() => {
        if (this.store.detail?.id === photoId) this.store.detail = updated;
        this.store.photos = this.store.photos.map((p) =>
          p.id === photoId ? { ...p, rating: updated.rating, triage: updated.triage } : p,
        );
      });
      // A verdict or rating can move a photo out of the slice being viewed, and
      // the point of rejecting from the Active view is that the frame leaves it.
      // Re-read rather than filtering locally, which would mean a second copy of
      // the server's filter logic to drift out of step.
      const f = this.store.filters;
      if (f.triage != null || f.rated != null) await this.fetchPage();
    } catch (err) {
      runInAction(() => (this.store.error = message(err)));
    }
  }

  private async fetchPage(): Promise<void> {
    const source = this.store.source;
    if (source == null) return;

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    runInAction(() => {
      this.store.loading = true;
      this.store.error = null;
    });

    const f = this.store.filters;
    const params: PhotoListParams = {
      offset: this.store.offset,
      limit: this.store.limit,
      rated: f.rated,
      triage: f.triage,
      is_missing: f.isMissing,
      needs_processing: f.needsProcessing,
      taken_from: f.takenFrom,
      taken_to: f.takenTo,
      match: f.match,
      ordering: this.store.ordering,
      ...(f.search != null && f.search !== '' ? { q: f.search } : {}),
    };

    try {
      const page = await this.fetchFor(source, params);
      if (controller.signal.aborted) return;
      runInAction(() => {
        this.store.photos = page.photos;
        this.store.total = page.total;
        this.store.loading = false;
        this.store.reloadToken++;
        // Keep the keyboard cursor inside the new page: binning the last photo
        // would otherwise leave focus pointing past the end.
        if (this.store.focusIndex >= page.photos.length) this.store.focusIndex = page.photos.length - 1;
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      runInAction(() => {
        this.store.loading = false;
        this.store.error = message(err);
      });
    }
  }

  private fetchFor(source: PhotoSource, params: PhotoListParams): Promise<PhotoListResponse> {
    switch (source.kind) {
      case 'library':
        return api.listLibraryPhotos(source.libraryId, params);
      case 'shoot':
        return api.listShootPhotos(source.shootId, params);
      case 'album':
        return api.listAlbumPhotos(source.albumId, params);
      case 'missing':
        return api.listMissingPhotos(source.libraryId, params);
      case 'bin':
        // include_deleted lifts the default exclusion, is_deleted narrows it back
        // to *only* the soft-deleted rows.
        return api.listLibraryPhotos(source.libraryId, { ...params, include_deleted: true, is_deleted: true });
    }
  }

  @action.bound
  private beginLoad(source: PhotoSource): void {
    this.store.source = source;
    this.store.offset = 0;
    this.store.selected = new Set();
    this.store.lastToggled = null;
    this.store.focusIndex = -1;
    // The Bin and the missing view are already a specific slice, so a triage
    // default there would fight the thing the user opened.
    this.store.filters = source.kind === 'library' || source.kind === 'shoot' || source.kind === 'album' ? activeFilters() : {};
    this.store.ordering = 'taken_desc';
    this.store.error = null;

    // Anything the user chose last time they were here wins over those defaults.
    const saved = loadViewState(source);
    if (saved?.ordering != null) this.store.ordering = saved.ordering;
    if (saved?.filters != null) this.store.filters = saved.filters;
    if (saved?.thumbSize != null) this.store.thumbSize = saved.thumbSize;
    if (saved?.mode != null) this.store.mode = saved.mode;
  }

  private remember(): void {
    const source = this.store.source;
    if (source == null) return;
    saveViewState(source, {
      ordering: this.store.ordering,
      filters: this.store.filters,
      thumbSize: this.store.thumbSize,
      mode: this.store.mode,
    });
  }

  @action.bound
  private applyFilters(filters: PhotoFilters): void {
    this.store.filters = filters;
    this.store.offset = 0;
    this.remember();
  }

  @action.bound
  private applyOrdering(ordering: Ordering): void {
    this.store.ordering = ordering;
    this.store.offset = 0;
    this.remember();
  }

  // Deliberately keeps the previous detail on screen while the next one loads.
  // Clearing it made library_id momentarily null, which collapsed the rail and
  // title on every next/prev and read as a flash.
  @action.bound
  private beginDetail(): void {
    this.store.detailLoading = true;
    this.store.notesSavedAt = null;
    this.store.error = null;
  }

  @action.bound
  private setOffset(offset: number): void {
    this.store.offset = offset;
  }
}

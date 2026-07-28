import { action, runInAction } from 'mobx';
import {
  ApiError,
  api,
  type Ordering,
  type PhotoListParams,
  type PhotoListResponse,
  type PhotoSummary,
  type PreviewRendition,
  type ProcessingStage,
  type Rendition,
  type Triage,
} from '../../api/client';
import type { AlbumsPresenter } from '../albums/albums_presenter';
import type { AppSettingsPresenter } from '../settings/app_settings_presenter';
import type { AppSettingsStore } from '../settings/app_settings_store';
import type { ShootsPresenter } from '../shoots/shoots_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { activeFilters, type PhotoFilters, type PhotoSource, type PhotosStore, type ViewMode } from './photos_store';
import { loadViewState, saveViewState } from './view_state';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

// The code and status the message alone cannot carry. A bare "Unexpected error"
// leaves nothing to search the server log for; the code and status do.
function detail(err: unknown): string | undefined {
  if (err instanceof ApiError) return err.status === 0 ? err.code : `${err.code} · HTTP ${err.status}`;
  return err instanceof Error ? err.name : undefined;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function renditionLabel(rendition: PreviewRendition): string {
  if (rendition === 'embedded') return 'embedded JPEG';
  return rendition === 'full' ? 'RAW render' : 'RAW render (max quality)';
}

export class PhotosPresenter {
  // Only the newest list request may write to the store; an older one that
  // resolves late (slow page of a big library) would otherwise overwrite it.
  private inFlight: AbortController | null = null;
  // Photos already asked for on-demand build. A stage that fails, is re-mounted
  // and fails again reports missing each time: without this every one of them
  // would queue the same job again.
  private readonly previewBuilds = new Set<string>();

  constructor(
    private readonly store: PhotosStore,
    private readonly shoots: ShootsPresenter,
    private readonly albums: AlbumsPresenter,
    private readonly toasts: ToastsPresenter,
    private readonly settings: AppSettingsStore,
    private readonly settingsPresenter: AppSettingsPresenter,
  ) {}

  async open(source: PhotoSource): Promise<void> {
    this.beginLoad(source);
    await this.fetchPage();
  }

  async reload(): Promise<void> {
    if (this.store.source == null) return;
    await this.fetchPage();
  }

  // Whether what this view shows depends on which photos have been thumbnailed,
  // and so goes stale as a run works through them. Only the filter does: the rows
  // themselves are settled once the scan has finished inserting them, and their
  // thumbnails arrive by announcement (§18.6) rather than by re-reading the list.
  get tracksProcessing(): boolean {
    return this.store.filters.needsTile != null;
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
    const photo = this.store.photos.find((p) => p.id === photoId) ?? this.store.detailFor(photoId);
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
      this.fail(err);
    }
  }

  async refreshMetadataForSelection(): Promise<void> {
    await this.refreshMetadata(this.store.selectedIds);
    this.clearSelection();
  }

  // The rendition the user asked for, which is also the one to reopen at: which
  // of those two memories it lands in is the setting's business, not this one's
  // (§10.2).
  async chooseRendition(photoId: string, rendition: PreviewRendition): Promise<void> {
    await this.showRendition(photoId, rendition);
    if (this.store.rendition !== rendition) return; // the build failed; nothing to remember
    if (this.settings.previewRenditionMode === 'remember_per_photo') await this.patch(photoId, { preview_rendition: rendition });
    else await this.settingsPresenter.rememberRendition(rendition);
  }

  // Every rendition is rebuilt from scratch rather than served from the file that
  // already exists. For working on the pipeline itself: the file *is* the cache,
  // so a change to a decode setting is invisible on every photo already looked at
  // until something deletes what is there.
  @action.bound
  setForceRebuild(force: boolean): void {
    this.store.forceRebuild = force;
  }

  // Builds the rendition the first time and serves the cached file every time
  // after. The camera's JPEG is never built: it is the RAW's own bytes (§10.2).
  private async showRendition(photoId: string, rendition: PreviewRendition): Promise<void> {
    // The camera's JPEG comes straight out of the RAW, so there is no cached
    // build to force past.
    const force = this.store.forceRebuild && rendition !== 'embedded';
    // The detail on hand is the previous photo's until this one's fetch lands, so
    // "already built" has to be read from *this* photo's entry or not at all:
    // trusting the neighbour's said a file existed that was never built here, and
    // the build was skipped in favour of a 404.
    const built = this.store.detailFor(photoId)?.renditions?.[rendition]?.built === true;
    runInAction(() => (this.store.buildingRendition = true));
    try {
      if (rendition !== 'embedded' && (force || !built)) await api.buildRendition(photoId, rendition, force);
      // The build may have written an HDR video beside the still, and only the
      // detail knows whether one exists. Without this, Firefox keeps showing the
      // dark still until the page is reloaded (§10.7).
      await this.refreshDetail();
      if (!this.isCurrent(photoId)) return;
      runInAction(() => (this.store.rendition = rendition));
    } catch (err) {
      this.fail(err);
    } finally {
      runInAction(() => (this.store.buildingRendition = false));
    }
  }

  // The server has rewritten one of this photo's derived files. Written into the
  // row every view already renders from, which is what moves that file's URLs on;
  // mobx notifies the one tile whose field changed and nothing else.
  //
  // Only the stamp for the stage that moved: the grid tile and the viewer's
  // renditions have one each, so rebuilding a photo's renditions leaves its tile
  // where it is rather than re-fetching bytes that did not change.
  @action.bound
  renditionsRebuilt(photoId: string, stage: ProcessingStage, version: string): void {
    const field = stage === 'tile' ? 'tile_built_at' : 'renditions_built_at';
    const row = this.store.photos.find((p) => p.id === photoId);
    if (row != null) row[field] = version;
    const detail = this.store.detailFor(photoId);
    if (detail != null) detail[field] = version;
  }

  // Reported by the stage when a frame has decoded, so the panel beside it can
  // describe what is on screen rather than what a column claims.
  @action.bound
  imageShown(width: number, height: number): void {
    this.store.shownImage = { width, height };
  }

  // Whether a photo is still the one the view is on. Every write that lands after
  // an await has to ask: the store holds one detail and one chosen rendition, so
  // a request that resolves after the user has stepped on would otherwise put the
  // photo they left back on screen, or apply its rendition to the one they are
  // looking at now.
  private isCurrent(photoId: string): boolean {
    return this.store.open?.id === photoId;
  }

  // What still has to be applied to open this photo where the setting asks, or
  // null when the viewer resolved that from the row on its own - which is the
  // usual answer now that every fact the setting reads is on the row.
  private renditionToApply(): PreviewRendition | null {
    const target = this.store.preferredRendition;
    return target == null || target === this.store.showing ? null : target;
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
    this.beginDetail(photoId);
    // Before the fetch, not before the call: the settings decide which rendition
    // this photo opens at, but waiting on them to say the detail is in flight
    // leaves the page unable to tell "loading" from "no such photo".
    await this.settingsPresenter.load();
    try {
      const detail = await api.getPhoto(photoId);
      // Two of these can be in flight at once - stepping faster than the fetch -
      // and they need not answer in order. The straggler's photo is one the user
      // has already left, so writing it would replace the detail on screen with
      // the one before it and leave the page reporting the open photo as missing.
      if (!this.isCurrent(photoId)) return;
      runInAction(() => {
        this.store.loadedDetail = detail;
        this.store.open = { id: photoId, status: 'ready' };
      });
      // Landing straight on a photo URL leaves no collection loaded, so the
      // neighbours are unknown and prev/next are dead. Open the photo's library
      // so stepping works from a deep link as well as from the grid.
      if (this.store.source == null) await this.open({ kind: 'library', libraryId: detail.library_id });
      // A second await, and a slower one - a whole page of the library. The
      // rendition written below is a single shared field, so a reader who has
      // moved on while that was in flight must not have this photo's applied.
      if (!this.isCurrent(photoId)) return;
      const opening = this.renditionToApply();
      if (opening == null) return;
      // A rendition every photo already has needs no build, and no round trip to
      // learn that: it goes up as soon as the detail names it.
      if (this.store.isAlwaysBuilt(opening)) runInAction(() => (this.store.rendition = opening));
      else await this.showRendition(photoId, opening);
    } catch (err) {
      if (!this.isCurrent(photoId)) return;
      // On the open photo rather than in the store's shared error slot, which a
      // list fetch also writes: a library that failed to load must not read as
      // this photo being missing from the catalogue.
      runInAction(() => (this.store.open = { id: photoId, status: 'missing', error: message(err) }));
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
    // Blurring the box and stepping on is one gesture during a cull, so the save
    // routinely lands on a photo the reader has already left - where "saved"
    // would be a claim about a note they never wrote.
    if (!this.isCurrent(photoId)) return;
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
    // Mutated, not replaced: the map is observable, so `has(id)` is tracked per
    // id and only the tile whose membership changed re-renders.
    if (this.store.selected.has(photoId)) this.store.selected.delete(photoId);
    else this.store.selected.set(photoId, true);
    this.store.lastToggled = photoId;
  }

  // Shift-click selects everything between the last toggled photo and this one,
  // which is how you pick a burst without clicking forty times.
  @action.bound
  extendTo(photoId: string): void {
    const ids = this.store.photos.map((p) => p.id);
    // The cursor stands in for the anchor when nothing has been toggled yet:
    // arrowing to one photo and shift-clicking another is the same gesture as in
    // any file manager, and it is what a first shift-click has to reach for.
    const anchorId = this.store.lastToggled ?? this.store.photos[this.store.focusIndex]?.id ?? null;
    const anchor = anchorId == null ? -1 : ids.indexOf(anchorId);
    const target = ids.indexOf(photoId);
    if (anchor < 0 || target < 0) {
      this.toggle(photoId);
      this.focusAt(target);
      return;
    }
    const [from, to] = anchor <= target ? [anchor, target] : [target, anchor];
    for (const id of ids.slice(from, to + 1)) this.store.selected.set(id, true);
    // Moved here rather than by the caller, which would have to know to focus
    // *after* extending: focus is the fallback anchor, so focusing first would
    // make every range start and end on the photo just clicked.
    this.focusAt(target);
  }

  @action.bound
  selectAllOnPage(): void {
    this.store.selected.clear();
    for (const photo of this.store.photos) this.store.selected.set(photo.id, true);
  }

  @action.bound
  clearSelection(): void {
    this.store.selected.clear();
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

  // The grid tile alone, from the camera's JPEG an import builds it from (§10.2).
  // The photo view's renditions are left where they are: they are of the same
  // unchanged file, and rebuilding one is its own action in the viewer.
  //
  // Queued server-side, so this reports that the work started rather than that it
  // finished; every photo picks up its new file when the server announces it,
  // which is also what tells the grid.
  async regenerateThumbnails(): Promise<void> {
    const photoIds = this.store.selectedIds;
    if (photoIds.length === 0) return;
    try {
      const { queued } = await api.rebuildTiles(photoIds);
      await this.refreshDetail();
      this.toasts.show(`Rebuilt ${plural(queued, 'thumbnail', 'thumbnails')}`);
    } catch (err) {
      this.fail(err);
    }
    this.clearSelection();
  }

  // A photo whose processing never ran, or failed, has no rendition to serve and
  // nothing queued to change that, so the detail view would sit on "no preview
  // yet" indefinitely. Builds the one that is actually missing rather than
  // reprocessing from the embedded JPEG: that rebuilds the grid tile, which is
  // not what the viewer is asking for, so a library that renders would ask again
  // on the next paint and never stop.
  async buildMissingRendition(photoId: string, rendition: Rendition): Promise<void> {
    const key = `${photoId}:${rendition}`;
    if (this.previewBuilds.has(key)) return;
    this.previewBuilds.add(key);
    try {
      await api.buildRendition(photoId, rendition);
      await this.refreshDetail();
    } catch (err) {
      this.fail(err);
    } finally {
      // Only for as long as the build is running. Held past that, a build that
      // failed - a RAW that was briefly unreadable, a worker that could not spawn
      // - was never attempted again for the life of the tab, and the set grew
      // with every photo that ever asked.
      this.previewBuilds.delete(key);
    }
  }

  private async refreshDetail(): Promise<void> {
    const open = this.store.open;
    if (open == null) return;
    const detail = await api.getPhoto(open.id).catch(() => null);
    // The re-read is of whatever was open when it started, which a step during
    // the round trip has already replaced.
    if (detail != null && this.isCurrent(detail.id)) runInAction(() => (this.store.loadedDetail = detail));
  }

  // Binning is reversible, so it reports with an undo rather than asking first.
  async deletePhotos(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await api.deletePhotos(ids);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.clearSelection();
    await this.fetchPage();
    this.toasts.showUndoable(`${plural(ids.length, 'photo', 'photos')} moved to the Bin`, 'Undo', async () => {
      await api.restorePhotos(ids);
      await this.fetchPage();
    });
  }

  // An action that failed, as opposed to a view that cannot render. store.error
  // is the latter: it explains an empty grid or a missing photo, in place. A
  // failed rebuild or delete leaves the view perfectly renderable, so it belongs
  // in a toast that outlives the click and can be read at leisure.
  private fail(err: unknown): void {
    this.toasts.showError(message(err), detail(err));
  }

  private async bulk(run: () => Promise<void>, success: string): Promise<void> {
    if (this.store.selectedIds.length === 0) return;
    try {
      await run();
    } catch (err) {
      this.fail(err);
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
        // Into the object the panels are already reading, not over it: only the
        // fields that moved then notify, so rating a photo leaves the camera
        // settings and the paths beside it alone. Minus the two a patch cannot
        // change, which arrive as fresh objects every time and would look like a
        // change to whoever reads them - the frame and the preview panel, for a
        // star. What does move them says so itself (§18.6).
        const { renditions: _renditions, album_ids: _albums, ...changed } = updated;
        if (this.store.loadedDetail?.id === photoId) Object.assign(this.store.loadedDetail, changed);
        // Written into the row rather than mapped into a new array: replacing the
        // array invalidates every tile's observable, so rating one photo used to
        // re-render the whole grid.
        const row = this.store.photos.find((p) => p.id === photoId);
        if (row != null) {
          row.rating = updated.rating;
          row.triage = updated.triage;
          // The row answers which rendition to reopen this photo at, so a choice
          // written only to the detail would be forgotten on the step back to it.
          row.preview_rendition = updated.preview_rendition;
        }
      });
      // Only the field that changed can move a photo out of the slice being
      // viewed: a rating cannot change triage membership, and a note changes
      // neither. Testing the filters alone re-read the whole page every time a
      // star or a note was touched in the Active view, which is the default.
      // Re-read rather than filtering locally, which would mean a second copy of
      // the server's filter logic to drift out of step.
      const f = this.store.filters;
      const mayLeaveView =
        (fields.triage !== undefined && f.triage != null) || (fields.rating !== undefined && f.rated != null);
      if (mayLeaveView) await this.fetchPage();
    } catch (err) {
      this.fail(err);
    }
  }

  // Keeps the observable row object for any id the page still contains, writing
  // the server's fields into it. Handing back fresh objects would invalidate
  // every tile's observable on a refetch, so rejecting one photo re-rendered the
  // whole grid; mobx notifies only for the fields that actually differ.
  //
  // And the array itself when the page holds the same ids in the same order,
  // because assigning a new one notifies everything reading the list - the grid
  // and the controls above it - for a page that did not change. A sync polls
  // this once a second.
  private reconcile(rows: PhotoSummary[]): PhotoSummary[] {
    const current = this.store.photos;
    const byId = new Map(current.map((p) => [p.id, p]));
    const next = rows.map((row) => {
      const existing = byId.get(row.id);
      if (existing == null) return row;
      Object.assign(existing, row);
      return existing;
    });
    return next.length === current.length && next.every((row, i) => row === current[i]) ? current : next;
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
      needs_tile: f.needsTile,
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
        this.store.photos = this.reconcile(page.photos);
        this.store.total = page.total;
        this.store.loading = false;
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
    this.store.selected.clear();
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

  // Deliberately leaves `loadedDetail` alone: it is the previous photo's until
  // this one lands, and clearing it made library_id momentarily null, which
  // collapsed the rail and title on every next/prev and read as a flash.
  @action.bound
  private beginDetail(photoId: string): void {
    this.store.open = { id: photoId, status: 'loading' };
    this.store.notesSavedAt = null;
    // On the step rather than when the next detail lands: the panel must stop
    // claiming the previous photo's resolution the moment we navigate, and the
    // new frame can take a while to decode.
    this.store.shownImage = null;
    // Per photo, not sticky: the next photo may have no preview cached for the
    // rendition this one was showing, which would be a 404 rather than a picture.
    // Reopening it there is the setting's job, and it builds first.
    this.store.rendition = null;
  }

  @action.bound
  private setOffset(offset: number): void {
    this.store.offset = offset;
  }
}

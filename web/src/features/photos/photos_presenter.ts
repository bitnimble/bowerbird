import { action, comparer, reaction, runInAction } from 'mobx';
import {
  ApiError,
  api,
  downloadUrl,
  type Ordering,
  type PhotoListParams,
  type PhotoListResponse,
  type PhotoSelection,
  type PhotoSummary,
  type PhotoTarget,
  type ProcessingStage,
  type Rendition,
  type Triage,
  type ViewerRendition,
} from '../../api/client';
import type { AlbumsPresenter } from '../albums/albums_presenter';
import type { LibrariesPresenter } from '../libraries/libraries_presenter';
import type { AppSettingsPresenter } from '../settings/app_settings_presenter';
import type { AppSettingsStore } from '../settings/app_settings_store';
import type { ShootsPresenter } from '../shoots/shoots_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { BLOCK } from './grid_layout';
import { activeFilters, type PhotoFilters, type PhotoSource, type PhotosStore, type ViewMode } from './photos_store';
import { type IndexSample, SelectionRanges, rebase } from './selection';
import { loadViewState, saveViewState } from './view_state';

// Blocks of rows kept in memory at once. A scroll through a hundred thousand
// photos would otherwise accumulate every row it passed; two and a half thousand
// is far more than any viewport plus its overscan can hold, and small enough
// that the whole cache is a few megabytes whatever the library's size.
const MAX_BLOCKS = 24;

// Ids per request on the paths that still name photos by id - undoing a bin,
// which puts back exactly what it took. `PhotoIdListSchema` refuses more, so a
// longer list is sent as several requests rather than being capped.
const ID_BATCH = 1000;

function batches(ids: string[]): string[][] {
  const batched: string[][] = [];
  for (let from = 0; from < ids.length; from += ID_BATCH) batched.push(ids.slice(from, from + ID_BATCH));
  return batched;
}

// The collection a selection's positions are into. The bin and the missing view
// are the library plus a filter, so the server needs no scope of its own for
// them (§18.3.3).
function scopeOf(source: PhotoSource): PhotoSelection['scope'] {
  switch (source.kind) {
    case 'shoot':
      return { kind: 'shoot', id: source.shootId };
    case 'album':
      return { kind: 'album', id: source.albumId };
    default:
      return { kind: 'library', id: source.libraryId };
  }
}

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

export class PhotosPresenter {
  // Which blocks of the collection this client holds, and the request still out
  // for each one that is loading.
  private readonly blocks = new Map<number, 'loading' | 'loaded'>();
  private readonly controllers = new Map<number, AbortController>();
  // Block indices, most recently needed first: what eviction drops from the end.
  private recent: number[] = [];
  // Bumped whenever the collection being listed changes out from under the
  // requests in flight - a different filter, a different sort, a mutation that
  // moves rows between positions. A response from an older generation describes
  // a collection that no longer exists, so it is dropped rather than written at
  // an index that now holds something else.
  private generation = 0;
  // Photos already asked for on-demand build. A stage that fails, is re-mounted
  // and fails again reports missing each time: without this every one of them
  // would queue the same job again.
  private readonly renditionBuilds = new Set<string>();

  constructor(
    private readonly store: PhotosStore,
    private readonly libraries: LibrariesPresenter,
    private readonly shoots: ShootsPresenter,
    private readonly albums: AlbumsPresenter,
    private readonly toasts: ToastsPresenter,
    private readonly settings: AppSettingsStore,
    private readonly settingsPresenter: AppSettingsPresenter,
  ) {
    // The scroll is the only thing that decides what to fetch: move the viewport
    // (or open a photo near the edge of what is loaded) and the blocks that
    // answers for are requested, and the ones nothing needs any more are
    // dropped. Lives for the life of the app, like the presenter itself.
    reaction(() => this.store.neededBlocks, (blocks) => void this.ensureBlocks(blocks), {
      equals: comparer.structural,
      fireImmediately: true,
    });
  }

  async open(source: PhotoSource): Promise<void> {
    this.beginLoad(source);
    await this.ensureBlocks(this.store.neededBlocks);
  }

  async reload(): Promise<void> {
    if (this.store.source == null) return;
    await this.refresh();
  }

  // Whether what this view shows depends on which photos have a grid rendition,
  // and so goes stale as a run works through them. Only the filter does: the rows
  // themselves are settled once the scan has finished inserting them, and their
  // renditions arrive by announcement (§18.6) rather than by re-reading the list.
  get tracksProcessing(): boolean {
    return this.store.filters.needsTile != null;
  }

  // --- view controls ---

  async setFilters(filters: PhotoFilters): Promise<void> {
    this.applyFilters(filters);
    await this.ensureBlocks(this.store.neededBlocks);
  }

  // --- the scroller ---
  // The three facts every layout question is answered from. Written here so no
  // view has to measure the DOM to ask one (§18.3.2).

  @action.bound
  setViewport(width: number, height: number): void {
    // Masonry's blocks were measured at the old width, so they describe a layout
    // that no longer exists.
    if (this.store.viewportWidth !== width) this.store.blockHeights.clear();
    this.store.viewportWidth = width;
    this.store.viewportHeight = height;
  }

  @action.bound
  setScrollTop(top: number): void {
    this.store.scrollTop = top;
  }

  // A masonry block reporting the height it actually laid out to, replacing the
  // estimate the scroll was built from.
  @action.bound
  measuredBlock(block: number, height: number): void {
    this.store.blockHeights.set(block, height);
  }

  // Sorting a gallery edits the collection, because the sort *is* the
  // collection's, and that is what makes it the same on the next device to open
  // it. Written through the presenter that owns the entity, then re-read: the
  // next page comes back stating the ordering it was built in, so nothing here
  // has to assume the write landed.
  async setOrdering(ordering: Ordering): Promise<void> {
    const source = this.store.source;
    if (source == null) return;
    switch (source.kind) {
      case 'shoot':
        await this.shoots.setOrdering(source.shootId, ordering);
        break;
      case 'album':
        await this.albums.setOrdering(source.albumId, ordering);
        break;
      // The bin and the missing view are slices of the library, so they sort by
      // the library's own ordering rather than owning one.
      case 'library':
      case 'bin':
      case 'missing':
        await this.libraries.setOrdering(source.libraryId, ordering);
        break;
    }
    // A different sort puts different photos at every position, so nothing the
    // client is holding still describes where it sits.
    this.resetRows();
    await this.ensureBlocks(this.store.neededBlocks);
  }

  @action.bound
  setTileSize(px: number): void {
    this.store.tileSize = px;
    this.store.blockHeights.clear(); // a different zoom is a different masonry layout
    this.remember();
  }

  @action.bound
  setMode(mode: ViewMode): void {
    this.store.mode = mode;
    this.store.blockHeights.clear();
    this.remember();
  }

  // Sets a verdict straight from a grid tile, and pressing the verdict a photo
  // already has clears it, so one control covers all three states.
  async toggleTriage(photoId: string, verdict: Exclude<Triage, 'untriaged'>): Promise<void> {
    const photo = this.store.photoFor(photoId);
    if (photo == null) return;
    await this.setTriage(photoId, photo.triage === verdict ? 'untriaged' : verdict);
  }

  async refreshMetadata(target: PhotoTarget): Promise<void> {
    try {
      const { updated } = await api.refreshMetadata(target);
      await this.refreshDetail();
      this.toasts.show(`Refreshed metadata for ${plural(updated, 'photo', 'photos')}`);
    } catch (err) {
      this.fail(err);
    }
  }

  async refreshMetadataForSelection(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    await this.refreshMetadata(target);
    this.clearSelection();
  }

  // The rendition the user asked for, which is also the one to reopen at: which
  // of those two memories it lands in is the setting's business, not this one's
  // (§10.2).
  async chooseRendition(photoId: string, rendition: ViewerRendition): Promise<void> {
    await this.showRendition(photoId, rendition);
    if (this.store.rendition !== rendition) return; // the build failed; nothing to remember
    if (this.settings.viewerRenditionMode === 'remember_per_photo') await this.patch(photoId, { viewer_rendition: rendition });
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

  // The RAW, or any of the three renditions - built first when it is not on disk,
  // so the menu can offer all of them whatever happens to be cached. The server
  // refuses to build during a download, and a 404 in a navigation is the
  // browser's error page rather than something this app could report.
  async download(photoId: string, form: 'original' | ViewerRendition): Promise<void> {
    // The RAW and the camera's JPEG are both read out of a file that is already
    // there; only a render can be missing.
    if ((form === 'full' || form === 'max') && !(await this.ensureBuilt(photoId, form))) return;
    window.location.href = downloadUrl(photoId, form);
  }

  // Puts a rendition on screen, building it first if it is not on disk.
  private async showRendition(photoId: string, rendition: ViewerRendition): Promise<void> {
    if (!(await this.ensureBuilt(photoId, rendition))) return;
    if (!this.isCurrent(photoId)) return;
    runInAction(() => (this.store.rendition = rendition));
  }

  // Builds the rendition the first time and leaves the cached file alone every
  // time after. The camera's JPEG is never built: it is the RAW's own bytes
  // (§10.2). False when the build failed, so a caller does not go on to ask for a
  // file that is not there.
  private async ensureBuilt(photoId: string, rendition: ViewerRendition): Promise<boolean> {
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
      return true;
    } catch (err) {
      this.fail(err);
      return false;
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
    const row = this.store.rowById(photoId);
    if (row != null) row[field] = version;
    const detail = this.store.detailFor(photoId);
    if (detail != null) detail[field] = version;
  }

  @action.bound
  serverReachable(): void {
    this.store.serverEpoch++;
  }

  // Reported by the stage when a frame has decoded, so the panel beside it can
  // describe what is on screen rather than what a column claims. Carries which
  // file decoded, because the stage reports once per frame and the panel is read
  // on every render after it.
  @action.bound
  imageShown(photoId: string, rendition: ViewerRendition, width: number, height: number): void {
    this.store.shownImage = { photoId, rendition, width, height };
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
  private renditionToApply(): ViewerRendition | null {
    const target = this.store.preferredRendition;
    return target == null || target === this.store.showing ? null : target;
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

  // Anywhere in the collection, not just in what is loaded: the cursor walks the
  // whole thing, and the tile it lands on is at most a row outside the rendered
  // window, which the overscan already has mounted.
  @action.bound
  focusAt(index: number): void {
    if (this.store.total === 0) return;
    this.store.focusIndex = Math.max(0, Math.min(index, this.store.total - 1));
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
    await this.deletePhotos({ photo_ids: [photo.id] }, 1);
  }

  // --- selection ---

  @action.bound
  toggle(index: number): void {
    if (index < 0) return;
    this.store.selection = this.store.selection.toggle(index);
    this.store.lastToggled = index;
  }

  // Shift-click selects everything between the last toggled photo and this one,
  // which is how you pick a burst without clicking forty times. One range,
  // however long, so a burst and a whole library cost the same.
  @action.bound
  extendTo(index: number): void {
    // The cursor stands in for the anchor when nothing has been toggled yet:
    // arrowing to one photo and shift-clicking another is the same gesture as in
    // any file manager, and it is what a first shift-click has to reach for.
    const anchor = this.store.lastToggled ?? this.store.focusIndex;
    if (anchor < 0 || index < 0) {
      this.toggle(index);
      this.focusAt(index);
      return;
    }
    const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
    this.store.selection = this.store.selection.add(from, to);
    // Moved here rather than by the caller, which would have to know to focus
    // *after* extending: focus is the fallback anchor, so focusing first would
    // make every range start and end on the photo just clicked.
    this.focusAt(index);
  }

  /** Everything the grid currently has on screen. */
  @action.bound
  selectVisible(): void {
    const { from, to } = this.store.visible;
    this.store.selection = SelectionRanges.of(from, to - 1);
    this.store.lastToggled = null;
  }

  // The whole collection, however large: two numbers, and no ids at all - an
  // action on it names the positions and the server resolves them
  // (`selectionTarget`).
  @action.bound
  selectAll(): void {
    this.store.selection = SelectionRanges.of(0, this.store.total - 1);
    this.store.lastToggled = null;
  }

  @action.bound
  clearSelection(): void {
    this.store.selection = SelectionRanges.EMPTY;
    this.store.lastToggled = null;
  }

  // --- bulk actions ---
  // Cross-domain writes go through the sibling presenter, never the sibling store.

  async addSelectedToShoot(shootId: string): Promise<void> {
    await this.bulk(
      (target) => this.shoots.addPhotos(shootId, target),
      (n) => `Moved ${plural(n, 'photo', 'photos')} into the shoot`,
    );
  }

  async addSelectedToAlbum(albumId: string): Promise<void> {
    await this.bulk(
      (target) => this.albums.addPhotos(albumId, target),
      (n) => `Added ${plural(n, 'photo', 'photos')} to the album`,
    );
  }

  async removeSelectedFromShoot(shootId: string): Promise<void> {
    await this.bulk(
      (target) => this.shoots.removePhotos(shootId, target),
      (n) => `Moved ${plural(n, 'photo', 'photos')} back to the library root`,
    );
  }

  async removeSelectedFromAlbum(albumId: string): Promise<void> {
    await this.bulk(
      (target) => this.albums.removePhotos(albumId, target),
      (n) => `Removed ${plural(n, 'photo', 'photos')} from the album`,
    );
  }

  async deleteSelected(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    await this.deletePhotos(target, this.store.selectionCount);
  }

  async restoreSelected(): Promise<void> {
    await this.bulk(
      (target) => api.restorePhotos(target),
      (n) => `Restored ${plural(n, 'photo', 'photos')}`,
    );
  }

  // The grid rendition alone, from the camera's JPEG an import builds it from
  // (§10.2). The viewer's renditions are left where they are: they are of the
  // same unchanged file, and rebuilding one is its own action in the viewer.
  //
  // The request only answers once every rendition is written and every row
  // stamped, so the page is re-read from the collection rather than left to the
  // announcements that arrived alongside it. They still move each tile as it
  // lands, which is what fills the grid at the rebuild's pace - but one that goes
  // missing left its tile stale until the user reloaded, with no second chance,
  // and a bulk action reads back what it did (`bulk`).
  async rebuildGridRenditions(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    try {
      const { queued } = await api.rebuildTiles(target);
      await this.refreshDetail();
      await this.refresh();
      this.toasts.show(`Rebuilt ${plural(queued, 'grid rendition', 'grid renditions')}`);
    } catch (err) {
      this.fail(err);
    }
    this.clearSelection();
  }

  // A photo whose processing never ran, or failed, has no rendition to serve and
  // nothing queued to change that, so the detail view would sit on "no rendition
  // yet" indefinitely. Builds the one that is actually missing rather than
  // reprocessing from the embedded JPEG: that rebuilds the grid rendition, which
  // is not what the viewer is asking for, so a library that renders would ask
  // again on the next paint and never stop.
  async buildMissingRendition(photoId: string, rendition: Rendition): Promise<void> {
    const key = `${photoId}:${rendition}`;
    if (this.renditionBuilds.has(key)) return;
    this.renditionBuilds.add(key);
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
      this.renditionBuilds.delete(key);
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
  // `count` is only for the message; the request answers with what it actually
  // binned, which is what the undo puts back - the selection it was made from
  // resolves to different photos now that these have left the collection.
  async deletePhotos(target: PhotoTarget, count: number): Promise<void> {
    let binned: string[];
    try {
      binned = (await api.deletePhotos(target)).photo_ids;
    } catch (err) {
      this.fail(err);
      return;
    }
    this.clearSelection();
    await this.refresh();
    this.toasts.showUndoable(`${plural(count, 'photo', 'photos')} moved to the Bin`, 'Undo', async () => {
      for (const batch of batches(binned)) await api.restorePhotos({ photo_ids: batch });
      await this.refresh();
    });
  }

  // An action that failed, as opposed to a view that cannot render. store.error
  // is the latter: it explains an empty grid or a missing photo, in place. A
  // failed rebuild or delete leaves the view perfectly renderable, so it belongs
  // in a toast that outlives the click and can be read at leisure.
  private fail(err: unknown): void {
    this.toasts.showError(message(err), detail(err));
  }

  private async bulk(run: (target: PhotoTarget) => Promise<void>, success: (count: number) => string): Promise<void> {
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
    this.clearSelection();
    await this.refresh();
    this.toasts.show(success(count));
  }

  // The current selection as something a bulk request can carry: the collection,
  // the filters it was made under, and the runs of positions - never the ids,
  // which the server reads off the same listing the grid was built from
  // (§18.3.3). So acting on a hundred thousand photos is one small request, and
  // nothing is fetched to make a selection at all.
  //
  // Null when there is nothing selected, or when the view is a slice the server
  // has no scope for - which cannot happen, since the bin and the missing view
  // are the library plus a filter.
  private selectionTarget(): PhotoTarget | null {
    const source = this.store.source;
    if (source == null || !this.store.hasSelection) return null;
    const f = this.store.filters;
    return {
      selection: {
        scope: scopeOf(source),
        filters: {
          rated: f.rated,
          triage: f.triage,
          is_missing: f.isMissing,
          needs_tile: f.needsTile,
          taken_from: f.takenFrom,
          taken_to: f.takenTo,
          match: f.match,
          ...(f.search != null && f.search !== '' ? { q: f.search } : {}),
          // Last, because these are what makes the view that view rather than a
          // chip the reader could clear: the Bin is only the soft-deleted rows,
          // and the missing view only the ones whose file has gone.
          ...(source.kind === 'bin' ? { include_deleted: true, is_deleted: true } : {}),
          ...(source.kind === 'missing' ? { is_missing: true } : {}),
        },
        ranges: this.store.selection.ranges.map((range) => ({ ...range })),
      },
    };
  }

  private async patch(photoId: string, fields: Parameters<typeof api.updatePhoto>[1]): Promise<void> {
    try {
      const updated = await api.updatePhoto(photoId, fields);
      runInAction(() => {
        // Into the object the panels are already reading, not over it: only the
        // fields that moved then notify, so rating a photo leaves the camera
        // settings and the paths beside it alone. Minus the two a patch cannot
        // change, which arrive as fresh objects every time and would look like a
        // change to whoever reads them - the frame and the rendition panel, for a
        // star. What does move them says so itself (§18.6).
        const { renditions: _renditions, album_ids: _albums, ...changed } = updated;
        if (this.store.loadedDetail?.id === photoId) Object.assign(this.store.loadedDetail, changed);
        // Written into the row the grid is already rendering rather than over
        // it: replacing the object invalidates that tile's observable, and a
        // fresh one for every row would re-render the whole grid.
        const row = this.store.rowById(photoId);
        if (row != null) {
          row.rating = updated.rating;
          row.triage = updated.triage;
          // The row answers which rendition to reopen this photo at, so a choice
          // written only to the detail would be forgotten on the step back to it.
          row.viewer_rendition = updated.viewer_rendition;
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
      if (mayLeaveView) await this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  // --- loading the collection ---

  // Everything the client holds now describes a collection that has changed
  // under it, so every block is re-read. The rows themselves are left on screen
  // in the meantime: they are replaced in place as the answers land, which is
  // what keeps a bin, a restore or a sync poll from blanking the grid.
  private async refresh(): Promise<void> {
    if (this.store.source == null) return;
    // Where every row this client can name sat before the re-read. A scan
    // inserting under an open gallery renumbers positions, and the selection and
    // the cursor are both positions, so this is what they are put back against
    // afterwards (§18.3.3).
    const before = new Map(this.store.indexById);
    const whole = this.store.allSelected;
    const held = new Set(this.blocks.keys());
    this.invalidate();
    const blocks = this.refreshBlocks(held);
    await this.ensureBlocks(blocks);
    this.rebasePositions(before, new Set(blocks), whole);
  }

  // What to re-read: what is on screen, plus the blocks the selection covers
  // that this client still holds rows for - those are what make the rebase
  // exact where the reader actually built the selection.
  private refreshBlocks(held: Set<number>): number[] {
    const blocks = new Set(this.store.neededBlocks);
    for (const { start, end } of this.store.selection.ranges) {
      const last = Math.floor(end / BLOCK);
      for (let block = Math.floor(start / BLOCK); block <= last && blocks.size < MAX_BLOCKS; block++) {
        if (held.has(block)) blocks.add(block);
      }
    }
    return [...blocks].sort((a, b) => a - b);
  }

  // Puts the selection and the cursor back on the photographs they were on,
  // against a listing whose positions may have moved under them.
  @action.bound
  private rebasePositions(before: Map<string, number>, fetched: Set<number>, whole: boolean): void {
    // "Everything" survives as everything, including whatever arrived: it needs
    // no samples, and it is the one selection whose meaning is not a position.
    if (whole) {
      this.store.selection = SelectionRanges.of(0, this.store.total - 1);
      return;
    }
    const samples: IndexSample[] = [];
    for (const [index, row] of this.store.rows) {
      // Only rows that were actually re-read: the others still sit where they
      // were put, and would report a move of zero that never happened.
      if (!fetched.has(Math.floor(index / BLOCK))) continue;
      const from = before.get(row.id);
      if (from != null) samples.push({ from, to: index });
    }
    // Clamped to the collection, because a shift carried past the end of what
    // was sampled can name positions that do not exist. Left in, they would
    // count towards `selectionCount` - and a count that happened to reach the
    // total would read as "everything is selected" and be treated as such on the
    // next re-read.
    const last = this.store.total - 1;
    if (this.store.hasSelection) {
      this.store.selection = rebase(this.store.selection, samples).remove(this.store.total, Number.MAX_SAFE_INTEGER);
    }
    this.store.focusIndex = Math.min(this.moved(this.store.focusIndex, samples), last);
    const anchor = this.store.lastToggled == null ? null : this.moved(this.store.lastToggled, samples);
    this.store.lastToggled = anchor != null && anchor <= last ? anchor : null;
  }

  // One position through the same mapping the selection goes through, so the
  // cursor and the shift-click anchor stay on their own photographs too.
  private moved(index: number, samples: IndexSample[]): number {
    if (index < 0 || samples.length === 0) return index;
    return rebase(SelectionRanges.of(index, index), samples).ranges[0]?.start ?? index;
  }

  // Requests whatever of these blocks is missing and drops what nothing needs
  // any more. Idempotent: a block already loading is left to its own request.
  private async ensureBlocks(blocks: number[]): Promise<void> {
    if (this.store.source == null) return;
    const needed = new Set(blocks);
    this.recent = [...blocks, ...this.recent.filter((block) => !needed.has(block))];
    this.evict(needed);
    await Promise.all(blocks.filter((block) => !this.blocks.has(block)).map((block) => this.fetchBlock(block)));
  }

  private async fetchBlock(block: number): Promise<void> {
    const source = this.store.source;
    // Set before the first await, so two callers arriving in the same tick - the
    // reaction and whoever changed the filter it fired for - make one request.
    if (source == null || this.blocks.has(block)) return;
    this.blocks.set(block, 'loading');
    const controller = new AbortController();
    this.controllers.set(block, controller);
    const generation = this.generation;
    runInAction(() => {
      this.store.loading = true;
      this.store.error = null;
    });

    try {
      const page = await this.fetchFor(source, this.params(block * BLOCK, BLOCK));
      if (controller.signal.aborted || generation !== this.generation) return;
      runInAction(() => {
        this.merge(block, page.photos);
        this.store.total = page.total;
        this.store.ordering = page.ordering; // what it was actually sorted by, not what we hoped
        this.pruneBeyondTotal();
      });
      this.blocks.set(block, 'loaded');
    } catch (err) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.blocks.delete(block); // a failed block is not a loaded one; scrolling back asks again
      runInAction(() => (this.store.error = message(err)));
    } finally {
      // Only if this request is still the one registered: a block dropped and
      // scrolled back to has a second request out by now, and the straggler
      // clearing that one's entry would leave it untracked and unabortable.
      if (this.controllers.get(block) === controller) this.controllers.delete(block);
      runInAction(() => (this.store.loading = this.controllers.size > 0));
    }
  }

  private params(offset: number, limit: number): PhotoListParams {
    const f = this.store.filters;
    return {
      offset,
      limit,
      rated: f.rated,
      triage: f.triage,
      is_missing: f.isMissing,
      needs_tile: f.needsTile,
      taken_from: f.takenFrom,
      taken_to: f.takenTo,
      match: f.match,
      // No ordering: the collection's own is the answer, and asking for it back
      // rather than stating it is what keeps there being one copy of it.
      ...(f.search != null && f.search !== '' ? { q: f.search } : {}),
    };
  }

  // Keeps the observable row object wherever the same photo is still at the same
  // position, writing the server's fields into it. A fresh object invalidates
  // that tile's observable, so a sync polling once a second would re-render
  // every tile on screen for rows that had not moved; mobx notifies only for the
  // fields that actually differ.
  private merge(block: number, rows: PhotoSummary[]): void {
    rows.forEach((row, offset) => {
      const index = block * BLOCK + offset;
      const existing = this.store.rows.get(index);
      if (existing?.id === row.id) Object.assign(existing, row);
      else this.store.rows.set(index, row);
    });
  }

  // Rows past the end of a collection that has shrunk - a bin, a filter that now
  // matches less - along with the cursor, which would otherwise point past it.
  private pruneBeyondTotal(): void {
    const stale = [...this.store.rows.keys()].filter((index) => index >= this.store.total);
    for (const index of stale) this.store.rows.delete(index);
    if (this.store.focusIndex >= this.store.total) this.store.focusIndex = this.store.total - 1;
  }

  private evict(keep: Set<number>): void {
    const drop: number[] = [];
    let kept = 0;
    for (const block of this.recent) {
      if (keep.has(block) || ++kept <= MAX_BLOCKS) continue;
      drop.push(block);
    }
    if (drop.length === 0) return;
    runInAction(() => {
      for (const block of drop) {
        this.controllers.get(block)?.abort();
        this.controllers.delete(block);
        this.blocks.delete(block);
        for (let index = block * BLOCK; index < (block + 1) * BLOCK; index++) this.store.rows.delete(index);
      }
    });
    const dropped = new Set(drop);
    this.recent = this.recent.filter((block) => !dropped.has(block));
  }

  // Abandons every request in flight and forgets which blocks are held, without
  // touching the rows themselves.
  private invalidate(): void {
    this.generation++;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.blocks.clear();
    runInAction(() => (this.store.loading = false));
  }

  // Drops everything loaded, for a collection whose every position now holds
  // something else. Deliberately not the keyboard cursor: a filter is a narrower
  // view of the same photographs, and a cull works through them by keyboard, so
  // taking the cursor away at each switch would cost a keystroke to get back.
  // The next block to land clamps it into range (`pruneBeyondTotal`).
  @action.bound
  private resetRows(): void {
    this.invalidate();
    this.clearSelection(); // positions into a collection that no longer exists
    this.recent = [];
    this.store.rows.clear();
    this.store.blockHeights.clear();
    this.store.total = 0;
    this.store.scrollTop = 0;
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
    this.resetRows();
    this.store.focusIndex = -1; // a different collection, so the cursor has nothing to keep its place in
    // The Bin and the missing view are already a specific slice, so a triage
    // default there would fight the thing the user opened.
    this.store.filters = source.kind === 'library' || source.kind === 'shoot' || source.kind === 'album' ? activeFilters() : {};
    // Not guessed at: the collection states its own sort, and the first page
    // carries it. Until then the control has nothing to show, which is honest -
    // a value here would be a second answer racing the real one.
    this.store.ordering = null;
    this.store.error = null;

    // Anything the user chose last time they were here wins over those defaults.
    const saved = loadViewState(source);
    if (saved?.filters != null) this.store.filters = saved.filters;
    if (saved?.tileSize != null) this.store.tileSize = saved.tileSize;
    if (saved?.mode != null) this.store.mode = saved.mode;
  }

  private remember(): void {
    const source = this.store.source;
    if (source == null) return;
    saveViewState(source, {
      filters: this.store.filters,
      tileSize: this.store.tileSize,
      mode: this.store.mode,
    });
  }

  @action.bound
  private applyFilters(filters: PhotoFilters): void {
    this.store.filters = filters;
    // A different filter is a different collection: every position in it holds
    // something else, so nothing loaded against the last one survives.
    this.resetRows();
    this.remember();
  }

  // Deliberately leaves `loadedDetail` alone: it is the previous photo's until
  // this one lands, and clearing it made library_id momentarily null, which
  // collapsed the rail and title on every next/prev and read as a flash.
  @action.bound
  private beginDetail(photoId: string): void {
    this.store.open = { id: photoId, status: 'loading' };
    this.store.notesSavedAt = null;
    // Per photo, not sticky: the next photo may have nothing cached for the
    // rendition this one was showing, which would be a 404 rather than a picture.
    // Reopening it there is the setting's job, and it builds first.
    this.store.rendition = null;
  }
}

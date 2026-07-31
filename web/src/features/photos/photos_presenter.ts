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
import { displayRowOf, rowAt } from './bands';
import { BLOCK, atRailWall, recentred } from './grid_layout';
import {
  activeFilters,
  sourceKey,
  type Expansion,
  type PhotoFilters,
  type PhotoSource,
  type PhotosStore,
  type ViewMode,
} from './photos_store';
import { type IndexSample, SelectionRanges, rebase } from './selection';
import type { Span } from '../../ui/virtual_rows';
import { loadViewState, saveViewState } from './view_state';

// Blocks of rows kept in memory at once. A scroll through a hundred thousand
// photos would otherwise accumulate every row it passed; two and a half thousand
// is far more than any viewport plus its overscan can hold, and small enough
// that the whole cache is a few megabytes whatever the library's size.
const MAX_BLOCKS = 24;

// How many photographs the viewer holds either side of the open one. The query
// costs the same for two as for fifty, so this is chosen to outrun a held arrow
// key rather than to save a row.
const NEIGHBOUR_WINDOW = 50;

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
  // Whether this generation still owes a count. Set when one starts, cleared by
  // the first block to ask (`fetchBlock`).
  private needsCount = true;
  // The re-read in flight, so the next one queues behind it rather than racing
  // it (`refresh`).
  private refreshing: Promise<void> = Promise.resolve();
  // A re-read already queued behind the one in flight. Every caller asks the same
  // question - "read the collection as it is now" - so a second request while one
  // is pending is answered by the one already coming rather than by another pass
  // (`refresh`).
  private queuedRefresh: Promise<void> | null = null;
  // Writes to a photo, in the order they were asked for. `api.updatePhoto` is a
  // bare fetch and nothing orders two writes to the same row, so a verdict
  // followed quickly by an undo could land the restore first and the rejection
  // second, leaving the server on `rejected` while the session believes the
  // photo is still in the pool. One chain for the whole presenter rather than one
  // per photo: a person makes one or two writes per decision, so there is nothing
  // for per-photo parallelism to buy, and total ordering needs no stale-response
  // detection - the second request is not sent until the first has resolved.
  private writing: Promise<unknown> = Promise.resolve();
  // One run fetch in flight at a time (`loadNeighbours`).
  private loadingNeighbours = false;
  // Photos already asked for on-demand build. A stage that fails, is re-mounted
  // and fails again reports missing each time: without this every one of them
  // would queue the same job again.
  private readonly renditionBuilds = new Set<string>();
  // Stacks whose members are on the wire, so a second click on the same badge
  // cannot open one band and correct the scroll for two.
  private readonly opening = new Set<string>();

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
    // `anchorTop` clamps the anchor to a collection that may have shrunk, but the
    // raw value it clamps has to come down with it: binning most of a library
    // shortens the collection and undoing the bin lengthens it again, and an
    // anchor left where it was springs the reader back to a position they were
    // clamped out of a moment before.
    reaction(() => this.store.anchorLimit, this.settleAnchor);
    // The run the viewer's arrows step through, re-centred when the reader gets
    // near an end of it (§19.5.3). Its own reaction rather than part of opening a
    // photo, because it is also what answers for a photo opened with no
    // collection loaded at all.
    reaction(() => this.store.neighbourAnchor, (photoId) => void this.loadNeighbours(photoId), { fireImmediately: true });
  }

  @action.bound
  private settleAnchor(): void {
    this.store.railAnchor = this.store.anchorTop;
  }

  async open(source: PhotoSource): Promise<void> {
    const held = this.store.source;
    // Stepping back out of the viewer re-opens the collection the reader never
    // left, so its rows, its scroll and its open bands are kept: a reset would
    // land them at the top of a gallery they were a thousand photos into. It is
    // still re-read in place, since something may have changed it while they
    // were away.
    if (held != null && sourceKey(held) === sourceKey(source)) {
      await this.refresh();
      return;
    }
    this.beginLoad(source);
    await this.ensureBlocks(this.store.neededBlocks);
  }

  /**
   * Re-centres the viewer's run on a photograph.
   *
   * One at a time and never aborted: this is a background warm, so a request the
   * reader has outrun costs a skipped fetch rather than a cancelled one, and the
   * anchor is a different id by then, which re-arms the reaction. At a genuine
   * end of the collection the anchor stops changing and it settles.
   */
  private async loadNeighbours(photoId: string | null): Promise<void> {
    const source = this.store.source;
    if (photoId == null || source == null || this.loadingNeighbours) return;
    this.loadingNeighbours = true;
    const generation = this.generation;
    try {
      const run = await api.photoNeighbours({
        scope: scopeOf(source),
        filters: this.selectionFilters(),
        photo_id: photoId,
        limit: NEIGHBOUR_WINDOW,
      });
      // The collection may have been replaced while this was out.
      if (this.generation !== generation || this.store.source !== source) return;
      runInAction(() => (this.store.neighbourhood = run));
    } catch {
      // Nothing to say: the arrows keep the run they have, and the next step
      // asks again. A background warm must not raise a toast.
    } finally {
      this.loadingNeighbours = false;
    }
  }

  /**
   * Everything between two photographs of this collection, uncollapsed.
   *
   * The scope and the filters are this presenter's to know, so a caller hands over
   * the two ends and nothing else - and gets the run back in the collection's own
   * order, which is the answer it would otherwise have to work out for itself.
   */
  async rangeBetween(from: string | null, to: string | null): Promise<PhotoSummary[]> {
    const source = this.store.source;
    if (source == null) return [];
    return api.photoRange({ scope: scopeOf(source), filters: this.selectionFilters(), from, to });
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
    // A filter moves every position, and an open band is pinned to a stack
    // rather than to a position precisely so it can follow (§19.6.1). Without
    // this it stays drawn at the row it was opened at, under whatever the filter
    // has since put there.
    await this.replaceBands();
  }

  // --- the scroller ---
  // Every layout question is answered from these, so no view has to measure the
  // DOM to ask one (§18.3.2).

  @action.bound
  setViewport(width: number, height: number): void {
    // Masonry's blocks were measured at the old width, so they describe a layout
    // that no longer exists.
    if (this.store.viewportWidth !== width) this.store.blockHeights.clear();
    this.store.viewportWidth = width;
    this.store.viewportHeight = height;
  }

  /** Where the scroller has got to. */
  @action.bound
  setRailTop(top: number): void {
    this.store.railTop = top;
    // The one place the rail is moved rather than followed. Writing `scrollTop`
    // mid-fling cancels the fling, so it waits until the reader is near an end.
    if (!atRailWall(top, this.store.contentHeight, this.store.viewportHeight)) return;
    const put = recentred(this.store.anchorTop, top, this.store.contentHeight, this.store.viewportHeight);
    this.store.railAnchor = put.anchorTop;
    this.store.railTop = put.railTop;
  }

  // Moves the view `dy` content pixels from where it was anchored. Whatever the
  // anchor cannot absorb goes to `railTop`, which the view follows (§18.3.2);
  // that only happens once the anchor is out of travel, which for a collection
  // shorter than the rail is always.
  //
  // `wasAnchoredAt` has to be read *before* whatever displaced the reader, because
  // every caller shrinks the collection as it displaces them. Read after,
  // `anchorTop` has already been clamped down by a smaller `anchorLimit` and `dy`
  // counts that clamp a second time: closing a band with the anchor at its limit
  // threw the reader a band-height past the band, and a masonry block measuring
  // shorter than its estimate threw them from 80% of the collection to near the
  // top.
  @action.bound
  private shiftView(dy: number, wasAnchoredAt: number): void {
    if (dy === 0) return;
    const target = wasAnchoredAt + dy;
    const anchor = Math.min(this.store.anchorLimit, Math.max(0, target));
    this.store.railAnchor = anchor;
    // Clamped to the rail rather than left for the browser to clamp on the write:
    // a collection that lost most of its height under the reader - every masonry
    // block measuring far short of its estimate - has no such position any more,
    // and the store must not claim one it would only be corrected out of a frame
    // later by a scroll event.
    const reach = Math.max(0, this.store.railHeight - this.store.viewportHeight);
    this.store.railTop = Math.min(reach, Math.max(0, this.store.railTop + (target - anchor)));
  }

  /**
   * Put a content position at the top of the viewport, for a jump the reader asked
   * for - the keyboard cursor leaving the window, Home, End, the thumb, the wheel
   * over the bar.
   */
  @action.bound
  scrollTo(contentTop: number): void {
    // Clamped, because masonry answers `focusContentTop` with a block top, and the
    // last block is often shorter than the viewport - so the target can sit past
    // where the collection can actually be scrolled to.
    const travel = Math.max(0, this.store.contentHeight - this.store.viewportHeight);
    const target = Math.min(travel, Math.max(0, contentTop));
    // Leaving the rail where it is whenever the target is inside it keeps arrowing
    // through a collection an ordinary scroll rather than a re-anchor per keystroke.
    const within = target - this.store.anchorTop;
    const reachable = within >= 0 && within <= this.store.railHeight - this.store.viewportHeight;
    const put = reachable
      ? { anchorTop: this.store.anchorTop, railTop: within }
      : recentred(target, 0, this.store.contentHeight, this.store.viewportHeight);
    this.store.railAnchor = put.anchorTop;
    this.store.railTop = put.railTop;
  }

  /** Jump to a fraction of the collection: the thumb, and Home and End. */
  @action.bound
  scrollToProgress(progress: number): void {
    const travel = Math.max(0, this.store.contentHeight - this.store.viewportHeight);
    this.scrollTo(Math.min(1, Math.max(0, progress)) * travel);
  }

  // How long the collection is, as the server just reported it.
  //
  // The last masonry block holds whatever is left over, so its measured height
  // describes a part-block. That is only true while it *is* last: an import moves
  // the end past it, and the height then reads as a full block - a tenth of one, in
  // a library that grew from 930 photos to 2,430 - and drags every estimate below it
  // with it. `estimatedBlockHeight` cannot tell, because by then it has no idea what
  // the count used to be, so the height is dropped here instead.
  @action.bound
  private setTotal(total: number): void {
    const wasLast = Math.ceil(this.store.total / BLOCK) - 1;
    if (Math.ceil(total / BLOCK) - 1 !== wasLast) this.store.blockHeights.delete(wasLast);
    this.store.total = total;
  }

  // A measurement outlives the band it was taken for otherwise, and a stack the
  // reader keeps opening and closing would leave one behind every time.
  @action
  private forgetStackTiles(open: ReadonlyMap<string, Expansion>): void {
    if (this.store.stackTileBoxes.size === 0) return;
    this.store.stackTileBoxes = new Map([...this.store.stackTileBoxes].filter(([stackId]) => open.has(stackId)));
  }

  /**
   * An open stack's tile in masonry, reporting where its line put it: its band cuts
   * the gap in its top edge to match, and caps its own rows against its height
   * (§19.6).
   */
  @action.bound
  measuredStackTile(stackId: string, x: number, width: number, height: number): void {
    const held = this.store.stackTileBoxes.get(stackId);
    const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
    if (held != null && same(held.x, x) && same(held.width, width) && same(held.height, height)) return;
    const next = new Map(this.store.stackTileBoxes);
    next.set(stackId, { x, width, height });
    this.store.stackTileBoxes = next;
  }

  /**
   * A masonry block reporting the height it actually laid out to, replacing the
   * estimate the scroll was built from.
   */
  @action.bound
  measuredBlock(block: number, height: number): void {
    const anchoredAt = this.store.anchorTop;
    // The first block on screen, not the one that measured. One measurement moves
    // the average, and the average is what every *unmeasured* block's height is, so
    // a block reporting 600 where 200 was assumed lifts every unmeasured block above
    // the reader too - a far larger push than its own difference.
    const first = this.store.visibleBlocks.from;
    const before = this.store.blockTops[first] ?? 0;
    this.store.blockHeights.set(block, height);
    this.shiftView((this.store.blockTops[first] ?? 0) - before, anchoredAt);
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
    await this.replaceBands();
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
    this.reselectCursor();
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

  /**
   * @returns whether the write landed. Stack triage needs to know: it advances a
   * round on the strength of a rejection, and `patch` otherwise swallows a failure
   * into a toast, so a session would finish believing frames were rejected that
   * the server never took (§20.2).
   */
  async setTriage(photoId: string, triage: Triage, options: { quiet?: boolean } = {}): Promise<boolean> {
    return this.patch(photoId, { triage }, options);
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

  // Leaves the cursor on the photo the viewer was showing, so the grid it returns
  // to scrolls to where the reader got to rather than to where they went in. Only
  // the cursor: a reader who selected a set and opened one of them with Enter has
  // not asked for that set to be cut down to the photo they stepped to.
  //
  // A photo whose row this client is not holding cannot be scrolled to at all -
  // the grid works in positions - so the view is left where it was.
  @action.bound
  focusOpenPhoto(): void {
    const at = this.store.detailIndex;
    if (at >= 0) this.store.focusIndex = at;
  }

  // The cursor and the selection are one thing, so arrowing onto a photo selects
  // it: one ring, and whatever the bar or a cull key acts on is what is ringed.
  // Building a set from the keyboard is Space, which toggles without moving.
  @action.bound
  moveFocus(delta: number): void {
    const from = this.store.focusIndex < 0 ? 0 : this.store.focusIndex + delta;
    this.focusAt(from);
    this.selectOnly(this.store.focusIndex);
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
    await this.deletePhotos({ photo_ids: [photo.id] });
  }

  // --- selection ---

  @action.bound
  toggle(index: number): void {
    if (index < 0) return;
    this.store.selection = this.store.selection.toggle(index);
    this.store.lastToggled = index;
  }

  // A plain click on a tile means "this one instead", not "this one as well":
  // the tile is the selection control now that there is no tick box, so building
  // a set is cmd-click and shift-click as it is in any file manager.
  @action.bound
  selectOnly(index: number): void {
    this.clearMemberSelection();
    if (index < 0) return;
    this.store.selection = SelectionRanges.of(index, index);
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

  /**
   * A run of positions, for "Select visible".
   *
   * The span comes from the view because the store cannot answer it: `visible` is
   * what is *mounted*, which is two overscan rows more than the reader can see in
   * grid and list, and a whole hundred-photo block in masonry (`onScreenSpan`).
   */
  @action.bound
  selectSpan(span: Span): void {
    this.clearMemberSelection();
    this.store.selection = SelectionRanges.of(span.from, span.to - 1);
    this.store.lastToggled = null;
  }

  // The whole collection, however large: two numbers, and no ids at all - an
  // action on it names the positions and the server resolves them
  // (`selectionTarget`).
  @action.bound
  selectAll(): void {
    this.clearMemberSelection();
    this.store.selection = SelectionRanges.of(0, this.store.total - 1);
    this.store.lastToggled = null;
  }

  // The reader dropping the selection, from the bar or with Escape. Takes the
  // cursor with it, since they are the same thing: a ring left behind with nothing
  // selected is a photo the cull keys still act on and the bar cannot see.
  @action.bound
  clearSelection(): void {
    this.clearSelectedPositions();
    this.store.selectedMembers = new Set();
    this.store.focusIndex = -1;
  }

  // The positions alone, for a collection whose positions now hold something else.
  // The cursor stays, since a filter is a narrower view of the same photographs
  // (§18.3.2) - and it is not selected here, because until the next block lands it
  // may name a row this collection does not have.
  @action
  private clearSelectedPositions(): void {
    this.store.selection = SelectionRanges.EMPTY;
    this.store.lastToggled = null;
  }

  // What an action leaves behind, once the photos it acted on are no longer the
  // selection: the cursor, selected. A cull that bins the photo it is on carries
  // on from the row that took its place, and the ring goes on saying which row
  // that is - a bare cursor would leave `Del` acting on a photo nothing marks.
  @action
  private reselectCursor(): void {
    this.store.lastToggled = null;
    // Members go with the positions: the action covered both (§19.6.1), so
    // leaving the band's picks ringed would offer them to the next one again.
    this.store.selectedMembers = new Set();
    const at = Math.min(this.store.focusIndex, this.store.total - 1);
    this.store.focusIndex = at;
    this.store.selection = at < 0 ? SelectionRanges.EMPTY : SelectionRanges.of(at, at);
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
    await this.deletePhotos(target);
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
      this.toasts.show(`Rebuilt ${plural(queued, 'thumbnail', 'thumbnails')}`);
    } catch (err) {
      this.fail(err);
    }
    this.reselectCursor();
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
  // The batch is stamped on the rows the bin takes, and the undo names it: the
  // selection this was made from resolves to different photographs now that
  // these have left the collection, and the ids themselves are something neither
  // side should be carrying a million of (§12.3).
  async deletePhotos(target: PhotoTarget): Promise<void> {
    const batch = crypto.randomUUID();
    let deleted: number;
    try {
      // How many it took, from the server: a selection can name positions that
      // no longer hold a photo, so the count on screen is not the answer.
      deleted = (await api.deletePhotos(target, batch)).deleted;
    } catch (err) {
      this.fail(err);
      return;
    }
    this.clearSelectedPositions();
    await this.refresh();
    this.reselectCursor();
    this.toasts.showUndoable(`${plural(deleted, 'photo', 'photos')} moved to the Bin`, 'Undo', async () => {
      await api.restorePhotos({ batch });
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
    this.clearSelectedPositions();
    await this.refresh();
    this.reselectCursor();
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
  // --- stacks (§19.6) ---

  /**
   * Opens or closes a stack's band of member rows.
   *
   * Opening one above the viewport displaces everything below it, so the view is
   * moved by exactly the height the band inserted and nothing appears to move.
   * Every input is a number the store already holds, which is what lets this be
   * arithmetic rather than a measurement.
   */
  @action.bound
  async toggleBand(stackId: string, position: number): Promise<void> {
    const open = this.store.expansions.get(stackId);
    if (open != null) {
      const was = this.anchoredPosition();
      const next = new Map(this.store.expansions);
      next.delete(stackId);
      this.store.expansions = next;
      this.forgetStackTiles(next);
      // Its members go out of the selection with it. Held on, they would be acted
      // on from behind a closed stack, with nothing on screen to say so - and the
      // collapsed row that replaces them is not the same thing as three of them
      // (§19.6.1). The rest of the selection stays: closing a band is not a
      // selection gesture.
      const closed = new Set(open.photos.map((photo) => photo.id));
      this.store.selectedMembers = new Set([...this.store.selectedMembers].filter((id) => !closed.has(id)));
      this.holdRowThroughBands(was);
      return;
    }
    // A second click while the members are still in flight would otherwise open
    // the band once and correct the scroll twice, because both calls see it
    // closed. The reader asked for open-then-closed, so the second click is
    // dropped rather than queued: the band is about to be open either way.
    if (this.opening.has(stackId)) return;
    this.opening.add(stackId);
    const source = this.store.source;
    const generation = this.generation;
    try {
      const photos = await api.listStackPhotos(stackId, this.bandScope());
      runInAction(() => {
        // The collection this was opened against may have been replaced while
        // the members were on the wire, and those positions describe a listing
        // that no longer exists.
        if (this.generation !== generation || this.store.source !== source) return;
        const was = this.anchoredPosition();
        const next = new Map(this.store.expansions);
        next.set(stackId, { stackId, position, photos });
        this.store.expansions = next;
        this.holdRowThroughBands(was);
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.opening.delete(stackId);
    }
  }

  // Where the reader is, for handing to `shiftView` after the collection's height
  // has changed under them. The row at the top of the viewport and where it was
  // drawn are what let a change to *several* bands at once be undone
  // (`replaceBands`), not just a change to one.
  private anchoredPosition(): { anchorTop: number; gridRow: number; displayRow: number } {
    const columns = this.store.columns;
    const bands = this.store.bands;
    const at = rowAt(Math.floor(this.store.virtualTop / this.store.rowHeight), bands, columns);
    const gridRow = at.kind === 'grid' ? at.row : Math.floor(at.band.position / columns);
    return {
      anchorTop: this.store.anchorTop,
      gridRow,
      // Which display row that row is drawn on *now*. What the correction below
      // compares against, so it needs no separate account of what moved.
      displayRow: displayRowOf(gridRow, bands, columns),
    };
  }

  // Keeps the reader on the same row of the collection through anything that moves
  // where it is drawn: one band opening or closing, or an arbitrary set of them
  // re-placed at once. Off how far the row itself moved, which is the one form that
  // describes all of it - a band at or below the reader's row moves it not at all.
  private holdRowThroughBands(was: ReturnType<PhotosPresenter['anchoredPosition']>): void {
    if (this.store.mode === 'masonry') return;
    const moved = displayRowOf(was.gridRow, this.store.bands, this.store.columns) - was.displayRow;
    this.shiftView(moved * this.store.rowHeight, was.anchorTop);
  }

  /**
   * Re-places every open band, and closes the ones whose stack has left.
   *
   * A band is pinned to its stack, never to the position it was opened at, so a
   * re-order or an import moves where it is drawn rather than closing it. The
   * server is asked for every band in one call: numbering rows costs an ordered
   * pass over the collection, and ten open bands must not mean ten of them.
   */
  async replaceBands(): Promise<void> {
    const source = this.store.source;
    if (source == null || this.store.expansions.size === 0) return;
    const keys = [...this.store.expansions.keys()];
    const generation = this.generation;
    try {
      const [positions, members] = await Promise.all([
        api.photoPositions({ scope: scopeOf(source), filters: this.selectionFilters(), keys }),
        // Re-read alongside the positions, because a refresh follows the actions
        // that change what a stack holds: without this, photos just removed from
        // a stack stay drawn in its band until it is closed and opened again.
        Promise.all(
          keys.map((stackId) =>
            api
              .listStackPhotos(stackId, this.bandScope())
              .then((photos) => [stackId, photos] as const)
              .catch(() => [stackId, null] as const),
          ),
        ),
      ]);
      runInAction(() => {
        if (this.generation !== generation || this.store.source !== source) return;
        const was = this.anchoredPosition();
        const fresh = new Map(members);
        const kept = new Map<string, Expansion>();
        for (const [stackId, open] of this.store.expansions) {
          // Only the bands this answer is about. One opened while it was in
          // flight was never asked for, so its absence here says nothing, and
          // dropping it would close a band the reader had just opened.
          if (!keys.includes(stackId)) {
            kept.set(stackId, open);
            continue;
          }
          const position = positions[stackId];
          const photos = fresh.get(stackId);
          // Absent means the stack is no longer in this collection at all - a
          // filter that excludes every member, or an unstack - which is the one
          // thing that closes a band on its own. A stack down to one member is
          // an ordinary photograph again, so its band closes with it.
          if (position == null || photos == null || photos.length < 2) continue;
          kept.set(stackId, { ...open, position, photos });
        }
        this.store.expansions = kept;
        this.forgetStackTiles(kept);
        // A re-read closes bands whose stack has left and re-places the rest, all
        // of it above the reader as often as not, so the view has to be put back on
        // the row it was on - the same correction one band's own toggle makes.
        this.holdRowThroughBands(was);
        // Members that have left every open band cannot be acted on any more.
        const live = new Set([...kept.values()].flatMap((band) => band.photos.map((photo) => photo.id)));
        this.store.selectedMembers = new Set([...this.store.selectedMembers].filter((id) => live.has(id)));
      });
    } catch (err) {
      this.fail(err);
    }
  }

  // What a band has to answer for: the album it is being shown in, and which
  // side of the bin the listing is on.
  private bandScope(): { albumId?: string; deleted?: boolean } {
    const source = this.store.source;
    return {
      albumId: source?.kind === 'album' ? source.albumId : undefined,
      deleted: source?.kind === 'bin' ? true : undefined,
    };
  }

  @action.bound
  toggleMember(photoId: string): void {
    const selected = new Set(this.store.selectedMembers);
    if (!selected.delete(photoId)) selected.add(photoId);
    this.store.selectedMembers = selected;
  }

  // A plain click inside a band means "this one instead" across the whole
  // selection, exactly as it does on a tile: cmd-click is what adds to it.
  @action.bound
  selectOnlyMember(photoId: string): void {
    this.store.selectedMembers = new Set([photoId]);
    this.clearSelectedPositions();
  }

  @action.bound
  clearMemberSelection(): void {
    this.store.selectedMembers = new Set();
  }

  /** Makes a stack of whatever is selected. */
  async stackSelection(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    try {
      await api.createStack(target);
      this.clearSelectedPositions();
      await this.refresh();
      this.reselectCursor();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Drops every photo out of a stack and deletes it. */
  async unstack(stackId: string): Promise<void> {
    try {
      await api.unstack(stackId);
      runInAction(() => {
        this.store.expansions.delete(stackId);
        this.store.expansions = new Map(this.store.expansions);
      });
      this.clearSelectedPositions();
      await this.refresh();
      this.reselectCursor();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Takes the selected band members out of the stacks they are in. */
  async removeSelectedFromStacks(): Promise<void> {
    const byStack = new Map<string, string[]>();
    for (const open of this.store.expansions.values()) {
      const chosen = open.photos.filter((photo) => this.store.selectedMembers.has(photo.id)).map((photo) => photo.id);
      if (chosen.length > 0) byStack.set(open.stackId, chosen);
    }
    if (byStack.size === 0) return;
    try {
      for (const [stackId, photoIds] of byStack) await api.removeFromStack(stackId, photoIds);
      this.clearMemberSelection();
      await this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  // The filters a server-side question about this collection has to carry, so
  // that a selection and a position lookup are asking about the same listing. A
  // second copy of this is a position meaning one photograph here and another
  // there (§19.5.1).
  private selectionFilters(): PhotoSelection['filters'] {
    const source = this.store.source;
    const f = this.store.filters;
    return {
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
      ...(source?.kind === 'bin' ? { include_deleted: true, is_deleted: true } : {}),
      ...(source?.kind === 'missing' ? { is_missing: true } : {}),
    };
  }

  private selectionTarget(): PhotoTarget | null {
    const source = this.store.source;
    if (source == null || !this.store.hasSelection) return null;
    return {
      selection: {
        scope: scopeOf(source),
        filters: this.selectionFilters(),
        ranges: this.store.selection.ranges.map((range) => ({ ...range })),
        // Photos picked out of an open band, which have no position to be in a
        // run (§19.6.1). The server takes each photo once, so a member whose
        // stack's row is also selected is not acted on twice.
        members: [...this.store.selectedMembers],
      },
    };
  }

  /**
   * @param options.quiet suppress the error toast, for a caller that reports
   * failures itself and in one place. Without it a failed triage verdict raises
   * both this toast and stack triage's own "could not be saved" list.
   * @returns whether the write landed.
   */
  private async patch(
    photoId: string,
    fields: Parameters<typeof api.updatePhoto>[1],
    options: { quiet?: boolean } = {},
  ): Promise<boolean> {
    // Behind whatever is already writing, so two writes to one photo cannot land
    // out of the order they were asked for.
    const done = this.writing.then(() => this.write(photoId, fields, options));
    this.writing = done.catch(() => undefined);
    return done;
  }

  private async write(
    photoId: string,
    fields: Parameters<typeof api.updatePhoto>[1],
    options: { quiet?: boolean },
  ): Promise<boolean> {
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
        // The band member as well as the row: a stack's members have no row of
        // their own in a collapsed listing, so a verdict set on one would answer
        // from the server and never show.
        // The viewer's run as well: a photo the reader stepped to may be held
        // only there - a stack member has no row of its own in a collapsed
        // listing - and a verdict set on one would answer from the server and
        // then silently revert.
        for (const held of [this.store.rowById(photoId), this.store.memberById(photoId), this.store.neighbourById(photoId)]) {
          if (held == null) continue;
          held.rating = updated.rating;
          held.triage = updated.triage;
          // The row answers which rendition to reopen this photo at, so a choice
          // written only to the detail would be forgotten on the step back to it.
          held.viewer_rendition = updated.viewer_rendition;
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
      // Not awaited, and deliberately outside the write chain. The chain orders
      // the *writes*; a re-read is a view concern nobody waits on, and awaiting it
      // here holds the next write behind a whole collection pass - which is
      // exactly the pile-up the coalescing exists to stop, since two calls can
      // then never overlap and so can never coalesce. Outside the `try` too: a
      // re-read that failed would otherwise report a write that landed as failed.
      if (mayLeaveView) void this.refresh();
      return true;
    } catch (err) {
      if (options.quiet !== true) this.fail(err);
      return false;
    }
  }

  // --- loading the collection ---

  // Everything the client holds now describes a collection that has changed
  // under it, so every block is re-read. The rows themselves are left on screen
  // in the meantime: they are replaced in place as the answers land, which is
  // what keeps a bin, a restore or a sync poll from blanking the grid.
  //
  // One at a time, always. Two of these overlap routinely - a sync poll ticking
  // while a verdict is being set - and each rebases the selection against a
  // snapshot the other has already moved, so the same shift is applied twice and
  // the selection ends up naming photographs nobody chose.
  // Coalesced, not merely serialised. Every caller asks the same question - read
  // the collection as it is now - so a request arriving while one is in flight is
  // answered by a single trailing pass rather than by one of its own. Holding a
  // cull key in the grid on the Active filter queues one verdict per keystroke,
  // and each of those was a full re-read of the same collection; a triage session
  // does the same thing once per round and again per closing write.
  private refresh(): Promise<void> {
    const queued = this.queuedRefresh;
    if (queued != null) return queued;
    const next = this.refreshing.then(() => {
      // Cleared as this one starts, so a request arriving *during* it queues the
      // next pass rather than being answered by the one already reading.
      this.queuedRefresh = null;
      return this.readAgain();
    });
    this.queuedRefresh = next.catch(() => undefined);
    this.refreshing = next.catch(() => undefined);
    return next;
  }

  private async readAgain(): Promise<void> {
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
    // Only the blocks that came back. A request that failed, or that a newer
    // generation overtook, left its old rows sitting where they were - sampling
    // those would report a move of zero that never happened.
    const landed = blocks.filter((block) => held.has(block) && this.blocks.get(block) === 'loaded');
    this.rebasePositions(before, landed, whole);
    // Open stacks are pinned to their stack rather than to a position, so a
    // re-order or an import moves where a band is drawn instead of closing it
    // (§19.6.1). After the rebase, since both answer the same question about the
    // same re-read and the selection's is the one with a local answer.
    await this.replaceBands();
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
  private rebasePositions(before: Map<string, number>, landed: number[], whole: boolean): void {
    // "Everything" survives as everything, including whatever arrived: it needs
    // no samples, and it is the one selection whose meaning is not a position.
    if (whole) {
      this.store.selection = SelectionRanges.of(0, this.store.total - 1);
      return;
    }
    // The old positions this re-read can actually speak for: the blocks it both
    // held rows for and read back. Everywhere else, a gap in the samples is
    // indistinguishable from a removal, so nothing is claimed (`rebase`).
    let domain = SelectionRanges.EMPTY;
    for (const block of landed) domain = domain.add(block * BLOCK, (block + 1) * BLOCK - 1);

    const samples: IndexSample[] = [];
    for (const [index, row] of this.store.rows) {
      const from = before.get(row.id);
      if (from != null && domain.has(from)) samples.push({ from, to: index });
    }

    if (this.store.hasSelection) this.store.selection = rebase(this.store.selection, samples, domain);
    this.store.focusIndex = this.moved(this.store.focusIndex, samples, domain);
    this.store.lastToggled = this.store.lastToggled == null ? null : this.moved(this.store.lastToggled, samples, domain);
  }

  // One position through the same mapping the selection goes through, so the
  // cursor and the shift-click anchor stay on their own photographs too. Left
  // where it is when the re-read cannot speak for it, which is the same choice
  // as leaving the scroll alone.
  private moved(index: number, samples: IndexSample[], domain: SelectionRanges): number {
    if (index < 0) return index;
    return rebase(SelectionRanges.of(index, index), samples, domain).ranges[0]?.start ?? index;
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

    // Only the first block of a generation asks for the total. Counting is a
    // scan of everything that matches - 774ms of a 792ms block at a million
    // photos - and nothing can change the count without starting a generation.
    const counting = this.needsCount;
    this.needsCount = false;

    try {
      const page = await this.fetchFor(source, this.params(block * BLOCK, BLOCK, counting), controller.signal);
      if (controller.signal.aborted || generation !== this.generation) return;
      runInAction(() => {
        this.merge(block, page.photos);
        if (page.total != null) this.setTotal(page.total);
        this.store.ordering = page.ordering; // what it was actually sorted by, not what we hoped
        this.pruneBeyondTotal();
      });
      this.blocks.set(block, 'loaded');
    } catch (err) {
      // The count went out with a request that never landed, so the next block
      // of this generation has to ask for it again.
      if (counting) this.needsCount = true;
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

  private params(offset: number, limit: number, count = true): PhotoListParams {
    const f = this.store.filters;
    return {
      offset,
      limit,
      count,
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
    // The blocks being kept count against the budget too, or the cache is
    // MAX_BLOCKS *plus* whatever is on screen.
    let kept = keep.size;
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
    this.needsCount = true; // a new pass over the collection, so the total is asked for again
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
    this.clearSelectedPositions(); // positions into a collection that no longer exists
    this.recent = [];
    // The viewer's run described the collection that has just been replaced. An
    // empty one makes `neighbourAnchor` ask again, which is the whole of the
    // invalidation this needs.
    this.store.neighbourhood = [];
    this.store.rows.clear();
    this.store.blockHeights.clear();
    this.store.total = 0;
    this.store.railTop = 0;
    this.store.railAnchor = 0;
  }

  private fetchFor(source: PhotoSource, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> {
    switch (source.kind) {
      case 'library':
        return api.listLibraryPhotos(source.libraryId, params, signal);
      case 'shoot':
        return api.listShootPhotos(source.shootId, params, signal);
      case 'album':
        return api.listAlbumPhotos(source.albumId, params, signal);
      case 'missing':
        return api.listMissingPhotos(source.libraryId, params, signal);
      case 'bin':
        // include_deleted lifts the default exclusion, is_deleted narrows it back
        // to *only* the soft-deleted rows.
        return api.listLibraryPhotos(source.libraryId, { ...params, include_deleted: true, is_deleted: true }, signal);
    }
  }

  @action.bound
  private beginLoad(source: PhotoSource): void {
    this.store.source = source;
    this.resetRows();
    // A different collection, so an open band describes photographs that are not
    // in it: its position indexes a listing that no longer exists, and its
    // members would be drawn as a band somewhere in the middle of the new one.
    // Filters and orderings keep their bands (they are re-placed); a different
    // library, shoot or album does not.
    this.store.expansions = new Map();
    this.store.selectedMembers = new Set();
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

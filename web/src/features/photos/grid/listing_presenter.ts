import { action, observable, runInAction } from 'mobx';
import { type PhotoListResponse, type PhotoSummary } from '../../../../../src/schemas/photos';
import type { RequestActivity } from '../../../../../src/schemas/request_activity';
import { albumsApi } from '../../../api/albums';
import { type PhotoListParams, photosApi } from '../../../api/photos';
import { shootsApi } from '../../../api/shoots';
import type { ScrollRailPresenter } from './scroll_rail_presenter';
import type { ListingStore } from './listing_store';
import { BLOCK, tileWidthForColumns } from './grid_layout';
import { openingFilters, type ModelPair, type PhotoDay, type PhotoFilters } from './photo_filters';
import type { PhotoSource, ViewMode } from '../photos_store';
import { type IndexSample, SelectionRanges } from '../selection';
import { loadViewState, saveViewState } from '../view_state';
import type { MarksStore } from './marks_store';
import type { ViewerStore } from '../viewer/viewer_store';
import type { SelectionPresenter } from './selection_presenter';
import type { StackActionsPresenter } from './stack_actions_presenter';
import type { ViewerPresenter } from '../viewer/viewer_presenter';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Blocks of rows kept in memory at once. A scroll through a hundred thousand
// photos would otherwise accumulate every row it passed; two and a half thousand
// is far more than any viewport plus its overscan can hold, and small enough
// that the whole cache is a few megabytes whatever the library's size.
export const MAX_BLOCKS = 24;

export class ListingPresenter {
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
  generation = 0;
  // Whether this generation still owes a count. Set when one starts, cleared by
  // the first block to ask (`fetchBlock`).
  needsCount = true;
  // The re-read in flight, so the next one queues behind it rather than racing
  // it (`refresh`).
  private refreshing: Promise<void> = Promise.resolve();
  // A re-read already queued behind the one in flight. Every caller asks the same
  // question - "read the collection as it is now" - so a second request while one
  // is pending is answered by the one already coming rather than by another pass
  // (`refresh`).
  private queuedRefresh: Promise<void> | null = null;
  private queuedRefreshActivity: RequestActivity = 'background';
  // The photo the run in hand was asked for. Observable, because the reaction
  // above compares against it.
  @observable accessor neighboursFor: string | null = null;

  constructor(
    private readonly listing: ListingStore,
    private readonly marks: MarksStore,
    private readonly viewer: ViewerStore,
    private readonly rail: ScrollRailPresenter,
    private readonly selection: SelectionPresenter,
    private readonly stackActions: StackActionsPresenter,
    private readonly viewerPresenter: ViewerPresenter,
  ) {}

  @action.bound
  setViewport(width: number, height: number): void {
    // The starts alone: they were packed at the old width, and only a block that is
    // mounted reports again. The heights are dropped by the first block to report at
    // the new width instead (`measuredBlock`), because a block's box and the
    // scroller's arrive in one observer batch and dropping them here threw away the
    // measurement that had come with it.
    if (this.listing.viewportWidth !== width) this.listing.blockStarts.clear();
    this.listing.viewportWidth = width;
    this.listing.viewportHeight = height;
  }

  @action.bound
  scrollToPosition(position: number): void {
    this.rail.scrollTo(this.listing.contentTopOf(position));
  }

  @action.bound
  measuredBlock(block: number, height: number, width: number): void {
    // The width the block itself laid out at, not the store's: a resize delivers
    // this box and the scroller's in one observer batch, blocks first, so dropping
    // the heights from the scroller's side threw away the measurement that had
    // just arrived at the new width - and a block whose height the resize did not
    // change reports nothing further, leaving the estimate standing for good.
    const relaid = Math.abs(width - this.listing.measuredWidth) >= 0.5;
    // Against the height already recorded for this block, never against the
    // estimate: a block that lays out at exactly what was guessed for it is a real
    // measurement, and skipping it left the guess in place to be replaced by the
    // next one.
    const known = this.listing.blockHeights.get(block);
    if (!relaid && known != null && Math.abs(known - height) < 0.5) return;
    const anchoredAt = this.listing.rail.anchor;
    // The first block on screen, not the one that measured. One measurement moves
    // the average, and the average is what every *unmeasured* block's height is, so
    // a block reporting 600 where 200 was assumed lifts every unmeasured block above
    // the reader too - a far larger push than its own difference.
    const first = this.listing.visibleBlocks.from;
    const before = this.listing.blockTops[first] ?? 0;
    if (relaid) {
      this.listing.blockHeights.clear();
      this.listing.measuredWidth = width;
    }
    this.listing.blockHeights.set(block, height);
    this.rail.shift((this.listing.blockTops[first] ?? 0) - before, anchoredAt);
  }

  @action.bound
  packedBlock(block: number, end: number): void {
    if (this.listing.blockStarts.get(block + 1) === end) return;
    this.listing.blockStarts.set(block + 1, end);
  }

  @action.bound
  setZoom(zoom: number): void {
    const columns = this.listing.maxZoom + 1 - zoom;
    this.listing.tileSize = tileWidthForColumns(this.listing.viewportWidth, columns);
    this.forgetMasonryLayout(); // a different zoom is a different masonry layout
    this.remember();
  }

  @action.bound
  setMode(mode: ViewMode): void {
    this.listing.mode = mode;
    this.forgetMasonryLayout();
    this.remember();
  }

  @action.bound
  setShowFilenames(show: boolean): void {
    this.listing.showFilenames = show;
    this.remember();
  }

  @action.bound
  forgetMasonryLayout(): void {
    this.listing.blockHeights.clear();
    this.listing.blockStarts.clear();
  }

  // The height of a block that was the last was measured from however many rows
  // were in that part-block. An import that fills it, or a filter that once put the
  // end past it, and the height then reads as a full block - a tenth of one, in
  // a library that grew from 930 photos to 2,430 - and drags every estimate below it
  // with it. `estimatedBlockHeight` cannot tell, having no idea what the count was
  // when the block was measured, so the height is dropped here instead.
  @action.bound
  setTotal(total: number, photoTotal: number): void {
    const wasLast = Math.ceil(this.listing.total / BLOCK) - 1;
    if (Math.ceil(total / BLOCK) - 1 !== wasLast) this.listing.blockHeights.delete(wasLast);
    this.listing.total = total;
    this.listing.photoTotal = photoTotal;
  }

  @action.bound
  setFacets(modelPairs: ModelPair[], photoDays: PhotoDay[]): void {
    this.listing.modelPairs = modelPairs;
    this.listing.photoDays = photoDays;
  }

  @action.bound
  setExpandStacks(expand: boolean): void {
    this.listing.expandStacks = expand;
  }

  @action.bound
  patchPhoto(photoId: string, fields: Partial<PhotoSummary>): void {
    const row = this.listing.rowById(photoId);
    if (row != null) Object.assign(row, fields);
  }

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
  refresh(activity: RequestActivity = 'interactive'): Promise<void> {
    if (activity === 'interactive') this.queuedRefreshActivity = activity;
    const queued = this.queuedRefresh;
    if (queued != null) return queued;
    const next = this.refreshing.then(() => {
      // Cleared as this one starts, so a request arriving *during* it queues the
      // next pass rather than being answered by the one already reading.
      this.queuedRefresh = null;
      const nextActivity = this.queuedRefreshActivity;
      this.queuedRefreshActivity = 'background';
      return this.readAgain(nextActivity);
    });
    this.queuedRefresh = next.catch(() => undefined);
    this.refreshing = next.catch(() => undefined);
    return next;
  }

  private async readAgain(activity: RequestActivity): Promise<void> {
    if (this.listing.source == null) return;
    // Where every row this client can name sat before the re-read. A scan
    // inserting under an open gallery renumbers positions, and the selection and
    // the cursor are both positions, so this is what they are put back against
    // afterwards (§18.3.3).
    const before = new Map(this.listing.indexById);
    const whole = this.marks.allSelected;
    const held = new Set(this.blocks.keys());
    // What a stack holds is one of the things a re-read exists to catch - stacking and unstacking
    // both end in one - and a closed stack has no band for `replaceBands` to correct. Dropped
    // rather than re-read here: the reaction on the selection asks again for the ones still picked,
    // and nothing else is looking.
    this.stackActions.clearStackMembers();
    this.invalidate();
    const blocks = this.refreshBlocks(held);
    await this.ensureBlocks(blocks, activity);
    // Only the blocks that came back. A request that failed, or that a newer
    // generation overtook, left its old rows sitting where they were - sampling
    // those would report a move of zero that never happened.
    const landed = blocks.filter((block) => held.has(block) && this.blocks.get(block) === 'loaded');
    this.rebasePositions(before, landed, whole);
    // Open stacks are pinned to their stack rather than to a position, so a
    // re-order or an import moves where a band is drawn instead of closing it
    // (§19.6.1). After the rebase, since both answer the same question about the
    // same re-read and the selection's is the one with a local answer.
    await this.stackActions.replaceBands(activity);
  }

  // What to re-read: what is on screen, plus the blocks the selection covers
  // that this client still holds rows for - those are what make the rebase
  // exact where the reader actually built the selection.
  private refreshBlocks(held: Set<number>): number[] {
    const blocks = new Set(this.viewer.neededBlocks);
    for (const { start, end } of this.marks.selection.ranges) {
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
    if (whole) return this.selection.rebasePositions([], SelectionRanges.EMPTY, true);
    // A re-read with nothing to compare - no row this client could name going in,
    // or no block it both held and read back - speaks for *nothing*. That is not
    // the same as finding that nothing recognisable came back, which is a real
    // observation and does drop the selection: here there was no observation at
    // all, so there is nothing to re-express and no ground to claim the reader's
    // photographs have gone. It happens whenever a refresh starts with the rows
    // cleared, which since the collapse can be switched off under the reader
    // (§19.5.4) includes the gap right after that switch - where a sync poll used
    // to wipe the selection it had just carried across.
    if (before.size === 0 || landed.length === 0) return;
    // The old positions this re-read can actually speak for: the blocks it both
    // held rows for and read back. Everywhere else, a gap in the samples is
    // indistinguishable from a removal, so nothing is claimed (`rebase`).
    let domain = SelectionRanges.EMPTY;
    for (const block of landed) domain = domain.add(block * BLOCK, (block + 1) * BLOCK - 1);

    const samples: IndexSample[] = [];
    for (const [index, row] of this.listing.rows) {
      const from = before.get(row.id);
      if (from != null && domain.has(from)) samples.push({ from, to: index });
    }

    this.selection.rebasePositions(samples, domain, false);
  }

  // Requests whatever of these blocks is missing and drops what nothing needs
  // any more. Idempotent: a block already loading is left to its own request.
  async ensureBlocks(blocks: number[], activity?: RequestActivity): Promise<void> {
    if (this.listing.source == null) return;
    const needed = new Set(blocks);
    this.recent = [...blocks, ...this.recent.filter((block) => !needed.has(block))];
    this.evict(needed);
    await Promise.all(blocks.filter((block) => !this.blocks.has(block)).map((block) => this.fetchBlock(block, activity)));
  }

  private async fetchBlock(block: number, requestedActivity?: RequestActivity): Promise<void> {
    const source = this.listing.source;
    // Set before the first await, so two callers arriving in the same tick - the
    // reaction and whoever changed the filter it fired for - make one request.
    if (source == null || this.blocks.has(block)) return;
    this.blocks.set(block, 'loading');
    const controller = new AbortController();
    this.controllers.set(block, controller);
    const generation = this.generation;
    runInAction(() => {
      this.listing.loading = true;
      this.listing.error = null;
    });

    // Only the first block of a generation asks for the total. Counting is a
    // scan of everything that matches - 774ms of a 792ms block at a million
    // photos - and nothing can change the count without starting a generation.
    const counting = this.needsCount;
    this.needsCount = false;

    try {
      const activity = requestedActivity ?? (counting && this.listing.rows.size === 0 ? 'interactive' : 'background');
      const page = await this.fetchFor(source, this.params(block * BLOCK, BLOCK, counting), controller.signal, activity);
      if (controller.signal.aborted || generation !== this.generation) return;
      runInAction(() => {
        this.merge(block, page.photos);
        if (page.total != null) this.setTotal(page.total, page.photo_total ?? page.total);
        this.listing.ordering = page.ordering; // what it was actually sorted by, not what we hoped
        this.pruneBeyondTotal();
      });
      this.blocks.set(block, 'loaded');
    } catch (err) {
      // The count went out with a request that never landed, so the next block
      // of this generation has to ask for it again.
      if (counting) this.needsCount = true;
      if (controller.signal.aborted || generation !== this.generation) return;
      this.blocks.delete(block); // a failed block is not a loaded one; scrolling back asks again
      runInAction(() => (this.listing.error = message(err)));
    } finally {
      // Only if this request is still the one registered: a block dropped and
      // scrolled back to has a second request out by now, and the straggler
      // clearing that one's entry would leave it untracked and unabortable.
      if (this.controllers.get(block) === controller) this.controllers.delete(block);
      runInAction(() => (this.listing.loading = this.controllers.size > 0));
    }
  }

  // `expandStacks` is stated rather than read so the switch itself can ask about
  // the listing it is moving to before anything commits to it (§19.5.4).
  params(offset: number, limit: number, count = true, expandStacks = this.listing.expandStacks): PhotoListParams {
    const f = this.listing.filters;
    return {
      offset,
      limit,
      count,
      rated: f.rated,
      triage: f.triage,
      is_missing: f.isMissing,
      is_hidden: f.isHidden,
      taken_from: f.takenFrom,
      taken_to: f.takenTo,
      camera_models: f.cameraModels,
      lens_models: f.lensModels,
      match: f.match,
      ...(expandStacks ? { expand_stacks: true } : {}),
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
      const existing = this.listing.rows.get(index);
      if (existing?.id === row.id) Object.assign(existing, row);
      else this.listing.rows.set(index, row);
    });
  }

  // Rows past the end of a collection that has shrunk - a bin, a filter that now
  // matches less - along with the cursor, which would otherwise point past it.
  private pruneBeyondTotal(): void {
    const stale = [...this.listing.rows.keys()].filter((index) => index >= this.listing.total);
    for (const index of stale) this.listing.rows.delete(index);
    this.selection.clampFocus();
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
        for (let index = block * BLOCK; index < (block + 1) * BLOCK; index++) this.listing.rows.delete(index);
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
    runInAction(() => (this.listing.loading = false));
  }

  // Drops everything loaded, for a collection whose every position now holds
  // something else. Deliberately not the keyboard cursor: a filter is a narrower
  // view of the same photographs, and a cull works through them by keyboard, so
  // taking the cursor away at each switch would cost a keystroke to get back.
  // The next block to land clamps it into range (`pruneBeyondTotal`).
  @action.bound
  resetRows(): void {
    this.invalidate();
    this.selection.clearSelectedPositions(); // positions into a collection that no longer exists
    this.recent = [];
    // The viewer's run described the collection that has just been replaced.
    // Clearing what it answered for is what makes the reaction ask again: the
    // anchor alone does not change when the open photo has not.
    this.viewerPresenter.clearNeighbourhood();
    this.neighboursFor = null;
    this.listing.rows.clear();
    this.forgetMasonryLayout();
    this.listing.total = 0;
    this.listing.photoTotal = 0;
    this.rail.reset();
  }

  fetchFor(source: PhotoSource, params: PhotoListParams, signal?: AbortSignal, activity?: RequestActivity): Promise<PhotoListResponse> {
    switch (source.kind) {
      case 'library':
        return photosApi.listLibrary(source.libraryId, params, signal, activity);
      case 'shoot':
        return shootsApi.listPhotos(source.shootId, params, signal, activity);
      case 'album':
        return albumsApi.listPhotos(source.albumId, params, signal, activity);
      case 'missing':
        return photosApi.listMissing(source.libraryId, params, signal, activity);
      case 'no_shoot':
        return photosApi.listLibrary(source.libraryId, { ...params, no_shoot: true }, signal, activity);
      case 'bin':
        // include_deleted lifts the default exclusion, is_deleted narrows it back
        // to *only* the soft-deleted rows.
        return photosApi.listLibrary(source.libraryId, { ...params, include_deleted: true, is_deleted: true }, signal, activity);
    }
  }

  @action.bound
  beginLoad(source: PhotoSource): void {
    this.listing.source = source;
    this.resetRows();
    // A different collection, so an open band describes photographs that are not
    // in it: its position indexes a listing that no longer exists, and its
    // members would be drawn as a band somewhere in the middle of the new one.
    // Filters and orderings keep their bands (they are re-placed); a different
    // library, shoot or album does not.
    this.stackActions.clearExpansions();
    this.selection.resetCollection(); // a different collection, so the cursor has nothing to keep its place in
    this.listing.filters = openingFilters(source);
    // The last collection's bodies and lenses, which are not this one's. Cleared
    // rather than left for `loadModels` to replace, or the menu offers a body this
    // collection was never shot on until it answers.
    this.listing.modelPairs = [];
    this.listing.photoDays = [];
    // Not guessed at: the collection states its own sort, and the first page
    // carries it. Until then the control has nothing to show, which is honest -
    // a value here would be a second answer racing the real one.
    this.listing.ordering = null;
    this.listing.error = null;

    // Anything the user chose last time they were here wins over those defaults.
    const saved = loadViewState(source);
    if (saved?.filters != null) this.listing.filters = saved.filters;
    if (saved?.tileSize != null) this.listing.tileSize = saved.tileSize;
    if (saved?.mode != null) this.listing.mode = saved.mode;
    this.listing.expandStacks = saved?.expandStacks ?? false;
    this.listing.showFilenames = saved?.showFilenames ?? true;
    this.selection.setDisplay(saved?.showTriage ?? true, saved?.showRating ?? true);
  }

  remember(): void {
    const source = this.listing.source;
    if (source == null) return;
    saveViewState(source, {
      filters: this.listing.filters,
      tileSize: this.listing.tileSize,
      mode: this.listing.mode,
      expandStacks: this.listing.expandStacks,
      showFilenames: this.listing.showFilenames,
      showTriage: this.marks.showTriage,
      showRating: this.marks.showRating,
    });
  }

  @action.bound
  applyFilters(filters: PhotoFilters): void {
    this.listing.filters = filters;
    // A different filter is a different collection: every position in it holds
    // something else, so nothing loaded against the last one survives.
    this.resetRows();
    this.remember();
  }

}

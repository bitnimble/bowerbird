import { action, comparer, computed, reaction, runInAction } from 'mobx';
import { type Ordering, type ProcessingStage } from '../../../../src/schemas/common';
import { type CompositeKind, type PhotoMarks, type PhotoSelection, type PhotoSummary, type PhotoTarget, type Triage } from '../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../src/schemas/settings';
import type { RequestActivity } from '../../../../src/schemas/request_activity';
import { type Rendition } from '../../../../src/services/processing/renditions/renditions';
import { photosApi } from '../../api/photos';
import { ApiError } from '../../api/request';
import { stacksApi } from '../../api/stacks';
import type { CompositeProgress } from '../../../../src/schemas/composition';
import type { AlbumsPresenter } from '../albums/albums_presenter';
import type { LibrariesPresenter } from '../libraries/libraries_presenter';
import type { AppSettingsPresenter } from '../settings/app_settings_presenter';
import type { AppSettingsStore } from '../settings/app_settings_store';
import { DeviceSettingsStore } from '../settings/device_settings_store';
import type { ShootsPresenter } from '../shoots/shoots_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { displayRowOf } from './grid/bands';
import { ScrollRailPresenter } from './grid/scroll_rail_presenter';
import { SelectionPresenter } from './grid/selection_presenter';
import { PhotosPresenterStrings } from './photos_presenter.strings';
import {
  sourceKey,
  type PhotoSource,
  type ViewMode,
} from './photos_store';
import { openingFilters, reachableModels, type PhotoFilters } from './grid/photo_filters';
import { SelectionRanges } from './selection';
import type { Span } from '../../ui/virtual_rows';
import { SharePresenter } from './viewer/share_presenter';
import { MarksPresenter } from './viewer/marks_presenter';
import { ViewerPresenter } from './viewer/viewer_presenter';
import { RenditionsPresenter } from './viewer/renditions_presenter';
import { DetailPresenter } from './viewer/detail_presenter';
import { BulkPresenter } from './grid/bulk_presenter';
import { StackActionsPresenter } from './grid/stack_actions_presenter';
import { ListingPresenter } from './grid/listing_presenter';
import type { ListingStore } from './grid/listing_store';
import type { MarksStore } from './grid/marks_store';
import type { StacksStore } from './grid/stacks_store';
import type { ViewerStore } from './viewer/viewer_store';

// Blocks of rows kept in memory at once. A scroll through a hundred thousand
// photos would otherwise accumulate every row it passed; two and a half thousand
// is far more than any viewport plus its overscan can hold, and small enough
// that the whole cache is a few megabytes whatever the library's size.
export const MAX_BLOCKS = 24;

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

// What makes a view that view rather than something the reader ticked: the Bin is
// only the soft-deleted rows, the missing view only the ones whose file has gone.
// Every question about the collection carries these, the models a filter menu can
// offer included - a body no row of *this* view was shot on is a tick that empties
// the grid.
function viewFilters(source: PhotoSource | null): PhotoSelection['filters'] {
  return {
    ...(source?.kind === 'bin' ? { include_deleted: true, is_deleted: true } : {}),
    ...(source?.kind === 'missing' ? { is_missing: true } : {}),
    ...(source?.kind === 'no_shoot' ? { no_shoot: true } : {}),
  };
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

// What names a row to the server: the stack it stands for, or the photograph
// itself (§19.6.1). The same key answers in either listing - collapsed it is the
// stack's one row, uncollapsed it is every member of it (§19.5.4).
function rowKey(photo: PhotoSummary): string {
  return photo.stack_id ?? photo.id;
}

export class PhotosPresenter {
  private readonly sharePresenter: SharePresenter;
  private readonly marksPresenter: MarksPresenter;
  private readonly selectionPresenter: SelectionPresenter;
  private readonly viewerPresenter: ViewerPresenter;
  private readonly renditionsPresenter: RenditionsPresenter;
  private readonly detailPresenter: DetailPresenter;
  private readonly bulkPresenter: BulkPresenter;
  private readonly stackActionsPresenter: StackActionsPresenter;
  private readonly listingPresenter: ListingPresenter;
  // Writes to a photo, in the order they were asked for. `photosApi.update` is a
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
  // Stacks whose members are on the wire for the *selection* rather than for a band, so a reader
  // dragging a range over a dozen stacks asks for each of them once.
  private readonly resolving = new Set<string>();

  /** The gallery's place in the collection. Its only writer, and the strip's own is a peer. */
  readonly rail: ScrollRailPresenter;

  constructor(
    private readonly listing: ListingStore,
    private readonly marks: MarksStore,
    private readonly stacks: StacksStore,
    private readonly viewer: ViewerStore,
    private readonly libraries: LibrariesPresenter,
    private readonly shoots: ShootsPresenter,
    private readonly albums: AlbumsPresenter,
    private readonly toasts: ToastsPresenter,
    private readonly settings: AppSettingsStore,
    private readonly settingsPresenter: AppSettingsPresenter,
    device: DeviceSettingsStore = new DeviceSettingsStore(),
  ) {
    this.viewerPresenter = new ViewerPresenter(viewer);
    this.sharePresenter = new SharePresenter(viewer, toasts);
    this.marksPresenter = new MarksPresenter(
      this.viewerPresenter,
      (photoId, fields, options) => this.patch(photoId, fields, options),
      (photoId) => this.isCurrent(photoId),
    );
    this.rail = new ScrollRailPresenter(listing.rail);
    this.selectionPresenter = new SelectionPresenter(listing, marks, viewer, stacks);
    this.stackActionsPresenter = new StackActionsPresenter(
      listing,
      marks,
      stacks,
      this.rail,
      this.selectionPresenter,
      toasts,
      () => this.listingPresenter.generation,
      (expandStacks) => this.selectionFilters(expandStacks),
      () => this.selectionTarget(),
      () => this.clearSelectedPositions(),
      () => this.dropConsumedSelection(),
      () => this.refresh(),
      (error) => this.fail(error),
    );
    this.listingPresenter = new ListingPresenter(
      listing,
      marks,
      viewer,
      this.rail,
      this.selectionPresenter,
      this.stackActionsPresenter,
      this.viewerPresenter,
    );
    this.detailPresenter = new DetailPresenter(
      listing,
      viewer,
      this.viewerPresenter,
      settingsPresenter,
      (photoId) => this.beginDetail(photoId),
      (source) => this.open(source),
      (photoId, rendition) => this.showRendition(photoId, rendition),
      (photoId) => this.isCurrent(photoId),
      (error) => this.fail(error),
      (run) => this.enqueueWrite(run),
    );
    this.bulkPresenter = new BulkPresenter(
      marks,
      shoots,
      albums,
      toasts,
      () => this.selectionTarget(),
      () => this.clearSelectedPositions(),
      () => this.dropConsumedSelection(),
      () => this.refresh(),
      () => this.refreshDetail(),
      (error) => this.fail(error),
    );
    this.renditionsPresenter = new RenditionsPresenter(
      viewer,
      device,
      this.viewerPresenter,
      this.listingPresenter,
      this.stackActionsPresenter,
      (activity) => this.refreshDetail(activity),
      (error) => this.fail(error),
      (photoId) => this.isCurrent(photoId),
    );
    // Never stopped: this presenter is the app's, and so is the gallery's rail.
    this.rail.watch();
    // The scroll is the only thing that decides what to fetch: move the viewport
    // (or open a photo near the edge of what is loaded) and the blocks that
    // answers for are requested, and the ones nothing needs any more are
    // dropped. Lives for the life of the app, like the presenter itself.
    reaction(() => this.viewer.neededBlocks, (blocks) => void this.listingPresenter.ensureBlocks(blocks), {
      equals: comparer.structural,
      fireImmediately: true,
    });
    // The run the viewer's arrows step through, re-centred when the reader gets
    // near an end of it (§19.5.3). Its own reaction rather than part of opening a
    // photo, because it is also what answers for a photo opened with no
    // collection loaded at all.
    // Against what the run in hand already answers for, not against the anchor
    // alone. The anchor is the open photo's id whenever the run does not cover it
    // *or* the reader is near an edge of it, so emptying the run - which every
    // filter change and re-open does - leaves the anchor at the same string and a
    // value-equality reaction never fires. The arrows then stay dead for as long
    // as that photo is open, which for a collection of twenty or fewer is every
    // photo in it.
    reaction(
      () => (this.viewer.neighbourAnchor === this.listingPresenter.neighboursFor ? null : this.viewer.neighbourAnchor),
      (photoId) => void this.loadNeighbours(photoId),
      { fireImmediately: true },
    );
    // The setting every held answer was resolved against. Choosing a rendition in the viewer
    // reports the move itself (`chooseRendition`), but the mode is changed in Settings, which
    // knows nothing about what this is holding - so without this a reader who opened twenty
    // photographs, switched the mode and went back to any of them was answered from a detail
    // read under the old one, and the setting appeared to do nothing at all.
    reaction(() => this.settings.viewerRenditionMode, this.renditionPolicyMoved);
    // What a selected stack tile stands for. Picking one is picking its contents (§19.6.1), so the
    // members have to be in hand for `selectedLoadedPhotos` to say so - and a reader who selects a
    // stack without ever opening its band is the common way to reach the merge menu.
    reaction(
      () => this.unresolvedSelectedStacks,
      (stackIds) => void this.resolveStacks(stackIds),
      { equals: comparer.structural, fireImmediately: true },
    );
  }

  /** Selected stack rows whose members this client does not hold yet. */
  @computed private get unresolvedSelectedStacks(): string[] {
    return this.marks.selectedLoadedRows
      .filter((row) => row.stack_size > 1 && row.stack_id != null && !this.stacks.stackMembers.has(row.stack_id))
      .map((row) => row.stack_id!);
  }

  /** One request a stack, at most once each: `stackMembers` is what says a stack is already known. */
  private async resolveStacks(stackIds: readonly string[]): Promise<void> {
    const scope = this.stackActionsPresenter.bandScope();
    if (scope == null) return;
    for (const stackId of stackIds) {
      if (this.resolving.has(stackId)) continue;
      this.resolving.add(stackId);
      try {
        const photos = await stacksApi.listPhotos(stackId, scope);
        runInAction(() => this.rememberStack(stackId, photos));
      } catch (err) {
        this.fail(err);
      } finally {
        this.resolving.delete(stackId);
      }
    }
  }

  @action.bound
  private rememberStack(stackId: string, photos: PhotoSummary[]): void {
    this.stackActionsPresenter.rememberStack(stackId, photos);
  }

  async open(source: PhotoSource): Promise<void> {
    const held = this.listing.source;
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
    void this.loadFilterFacets(source);
    await this.ensureBlocks(this.viewer.neededBlocks);
  }

  // What the collection was shot with, for the filter menu's two lists, and what it
  // holds per day, for the calendar's dots. Not awaited with the first page: the grid
  // does not wait on a menu nobody has opened yet, and a failure here leaves the menu
  // empty rather than the gallery unloaded.
  private async loadFilterFacets(source: PhotoSource): Promise<void> {
    try {
      const selection = { scope: scopeOf(source), filters: viewFilters(source) };
      const [{ pairs }, { days }] = await Promise.all([photosApi.models(selection), photosApi.days(selection)]);
      // By key, not by identity: the store's copy is a mobx proxy of what was
      // handed in, so `!==` is true of the collection this was asked for.
      const current = this.listing.source;
      if (current == null || sourceKey(current) !== sourceKey(source)) return;
      runInAction(() => {
        this.listingPresenter.setFacets(pairs, days);
      });
    } catch {
      // The menu stays as the collection opened it, which is empty: a list short of a
      // row, or a calendar with no dots, is not worth an error over the gallery.
    }
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
    const source = this.listing.source;
    if (photoId == null || source == null || this.loadingNeighbours) return;
    this.loadingNeighbours = true;
    const generation = this.listingPresenter.generation;
    try {
      const run = await photosApi.neighbours({
        scope: scopeOf(source),
        filters: this.selectionFilters(),
        photo_id: photoId,
        limit: NEIGHBOUR_WINDOW,
      });
      // The collection may have been replaced while this was out.
      if (this.listingPresenter.generation !== generation || this.listing.source !== source) return;
      runInAction(() => {
        this.viewerPresenter.setNeighbourhood(run);
        this.listingPresenter.neighboursFor = photoId;
      });
    } catch {
      // Answered for, even though it failed: without this the reaction re-fires on
      // the same id forever. The retry is the `finally` below, once.
      runInAction(() => (this.listingPresenter.neighboursFor = photoId));
    } finally {
      this.loadingNeighbours = false;
      // A request that arrived while this one was out was dropped rather than
      // queued, and the reaction will not fire again for an anchor it has already
      // seen - so ask here, inside the `finally`, because the stale-response
      // branch above returns straight past anything after the try.
      const again = this.viewer.neighbourAnchor;
      if (again != null && again !== this.listingPresenter.neighboursFor) void this.loadNeighbours(again);
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
    const source = this.listing.source;
    if (source == null) return [];
    return photosApi.range({ scope: scopeOf(source), filters: this.selectionFilters(), from, to });
  }

  async reload(activity: RequestActivity = 'interactive'): Promise<void> {
    if (this.listing.source == null) return;
    // Whatever moved out there moved for photographs this session has read details of, and
    // this is the one signal the client gets that it did: a peer's edits applying, a sync
    // landing, a library re-scanned. Kept, they answer every re-open for the life of the tab.
    this.forgetDetails();
    // The open photograph's is kept rather than dropped under the panels drawing from it, so
    // it is the one this has to re-read - and the only one whose staleness the reader can
    // actually see. `refresh` reads rows and bands and never touches a detail.
    await Promise.all([this.refresh(activity), this.refreshDetail(activity)]);
  }

  /**
   * Drops every remembered detail and develop document but the open photograph's.
   *
   * The open one is what the panels are rendering from, so it is re-read by whoever calls
   * this rather than dropped under them; the rest cost one fetch each on the next open,
   * which is what they cost before they were remembered at all.
   */
  @action.bound
  private forgetDetails(): void {
    this.detailPresenter.forgetRemembered();
  }

  // --- view controls ---

  /**
   * Ticks or unticks one body or lens.
   *
   * Unticking a body can strand the other list on lenses that were only ever on it,
   * which is a pair no photograph is - so where the two lists no longer meet, the one
   * the reader did not just touch gives way. It is left alone as long as they meet
   * anywhere: a body that adds nothing under the ticked lenses still says what the
   * reader asked for, and unticking it for them is a choice they cannot see being made.
   */
  async toggleModel(which: 'camera' | 'lens', model: string, checked: boolean): Promise<void> {
    const f = this.listing.filters;
    const key = which === 'camera' ? 'cameraModels' : 'lensModels';
    const ticked = f[key] ?? [];
    const next = checked ? [...ticked, model] : ticked.filter((m) => m !== model);
    const otherKey = which === 'camera' ? 'lensModels' : 'cameraModels';
    const other = f[otherKey] ?? [];
    const reachable = reachableModels(this.listing.modelPairs, which === 'camera' ? 'lens_model' : 'camera_model', next);
    const meets = other.length === 0 || other.some((m) => reachable.has(m));
    await this.setFilters({
      ...f,
      [key]: next.length === 0 ? undefined : next,
      [otherKey]: meets ? f[otherKey] : undefined,
    });
  }

  /**
   * Back to the collection as it opens: every question the reader asked dropped, and the
   * working set they started from restored, so this is the one control that empties the
   * badge rather than another way to narrow.
   */
  async resetFilters(): Promise<void> {
    await this.setFilters(openingFilters(this.listing.source));
  }

  async setFilters(filters: PhotoFilters): Promise<void> {
    this.applyFilters(filters);
    await this.ensureBlocks(this.viewer.neededBlocks);
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
    this.listingPresenter.setViewport(width, height);
  }

  /**
   * What the viewer's filmstrip is over, or null once it has gone.
   *
   * Written through `ViewerPresenter` rather than by the strip's own presenter because it is the
   * only writer of `ViewerStore` (§18.5); what the strip owns is its own view.
   */
  @action.bound
  setStripSpan(span: Span | null): void {
    this.viewerPresenter.setStripSpan(span);
  }

  /** The space the detail view's stage and panels share. */
  @action.bound
  setDetailBox(width: number, height: number): void {
    this.viewerPresenter.setDetailBox(width, height);
  }

  /** Put a photo at the start of the viewport, named by its position in the collection. */
  @action.bound
  scrollToPosition(position: number): void {
    this.listingPresenter.scrollToPosition(position);
  }

  /**
   * An open stack's tile in masonry, reporting where its line put it: its band cuts
   * the gap in its top edge to match, and caps its own rows against its height
   * (§19.6).
   */
  @action.bound
  measuredStackTile(stackId: string, x: number, width: number, height: number): void {
    this.stackActionsPresenter.measuredStackTile(stackId, x, width, height);
  }

  /**
   * A masonry block reporting the height it actually laid out to, replacing the
   * estimate the scroll was built from.
   */
  @action.bound
  measuredBlock(block: number, height: number, width: number): void {
    this.listingPresenter.measuredBlock(block, height, width);
  }

  /**
   * A masonry block reporting where its lines ran out, which is where the block
   * after it begins (`masonryBlockEnd`).
   *
   * Its own height follows through `measuredBlock` a frame later, so the scroll is
   * not adjusted here: doing both would move the view twice for one relayout.
   */
  @action.bound
  packedBlock(block: number, end: number): void {
    this.listingPresenter.packedBlock(block, end);
  }

  // Sorting a gallery edits the collection, because the sort *is* the
  // collection's, and that is what makes it the same on the next device to open
  // it. Written through the presenter that owns the entity, then re-read: the
  // next page comes back stating the ordering it was built in, so nothing here
  // has to assume the write landed.
  async setOrdering(ordering: Ordering): Promise<void> {
    const source = this.listing.source;
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
      case 'no_shoot':
        await this.libraries.setOrdering(source.libraryId, ordering);
        break;
    }
    // A different sort puts different photos at every position, so nothing the
    // client is holding still describes where it sits.
    this.resetRows();
    await this.ensureBlocks(this.viewer.neededBlocks);
    await this.replaceBands();
  }

  // Columns in, pixels out: `tileSize` is what the layout runs on, and what is persisted, but
  // it is not what the reader is choosing (`ListingStore.zoom`).
  @action.bound
  setZoom(zoom: number): void {
    this.listingPresenter.setZoom(zoom);
  }

  @action.bound
  setMode(mode: ViewMode): void {
    this.listingPresenter.setMode(mode);
  }

  // No masonry layout to forget: the foot is drawn over the photograph rather than under
  // it, so a name coming or going does not change the shape of a single tile. The same
  // goes for the two marks below it.
  @action.bound
  setShowFilenames(show: boolean): void {
    this.listingPresenter.setShowFilenames(show);
  }

  @action.bound
  setShowTriage(show: boolean): void {
    this.selectionPresenter.setShowTriage(show);
    this.remember();
  }

  @action.bound
  setShowRating(show: boolean): void {
    this.selectionPresenter.setShowRating(show);
    this.remember();
  }

  /**
   * Lists the collection uncollapsed, or collapses it again (§19.5.4).
   *
   * Every position in the collection changes, so the reader's place in it and
   * their selection are **re-expressed** against the new listing rather than
   * thrown away: each is named by the key of a row this client holds, and one
   * lookup answers for all of them at once.
   */
  async setExpandStacks(expand: boolean): Promise<void> {
    const source = this.listing.source;
    if (source == null || this.listing.expandStacks === expand) return;
    const anchor = this.anchorKey();
    // "Everything" is the one selection that is not a set of positions, so it
    // survives as everything rather than as whatever this client could name.
    const whole = this.marks.allSelected;
    const chosen = whole ? [] : this.selectionKeys();
    const cursor = this.listing.rows.get(this.marks.focusIndex) ?? null;
    const keys = [
      ...new Set([...(anchor == null ? [] : [anchor.key]), ...chosen, ...(cursor == null ? [] : [rowKey(cursor)])]),
    ];

    // Both reads describe the listing being switched *to*, which is stated rather
    // than taken from the store: the flag is what every other request reads too,
    // so flipping it before these had answered would have a sync poll fetching
    // blocks of one listing into a grid numbered by the other.
    const listing = this.listingKey(source, expand);
    let found: Record<string, number[]>;
    let total: number;
    let photoTotal: number;
    try {
      const [positions, page] = await Promise.all([
        keys.length === 0
          ? Promise.resolve<Record<string, number[]>>({})
          : photosApi.positions({ scope: scopeOf(source), filters: this.selectionFilters(expand), keys }),
        // The count alone. Read before the switch rather than after it so the
        // collection is the right height the moment the reader's row is put back
        // at the pixel it was on, instead of springing there once a block lands.
        this.listingPresenter.fetchFor(source, this.listingPresenter.params(0, 1, true, expand)),
      ]);
      found = positions;
      total = page.total ?? 0;
      photoTotal = page.photo_total ?? total;
    } catch (err) {
      this.fail(err);
      return;
    }
    // A filter, a sort or a different collection landing while this was out has
    // renumbered the listing these answers are about, so they describe neither
    // side of the switch any more. Nothing has changed here yet, so dropping them
    // costs the press and no more.
    //
    // The listing rather than the generation, which a plain re-read bumps too: a
    // sync poll ticks once a second through an import, and against the generation
    // the press was simply swallowed - button springing back, no toast - for as
    // long as the library was indexing.
    if (this.listingKey(source, expand) !== listing) return;

    const anchoredAt = anchor == null ? undefined : found[anchor.key]?.[0];
    this.applyExpandStacks({
      expand,
      total,
      photoTotal,
      selection: whole
        ? SelectionRanges.of(0, total - 1)
        : SelectionRanges.fromPositions(chosen.flatMap((key) => found[key] ?? [])),
      focusIndex: (cursor == null ? undefined : found[rowKey(cursor)]?.[0]) ?? -1,
      scrollTo: anchor == null || anchoredAt == null ? null : { position: anchoredAt, offset: anchor.offset },
    });
    await this.ensureBlocks(this.viewer.neededBlocks);
  }

  // What identifies the listing an answer is about: the collection, how it is
  // filtered and sorted, and whether it collapses. Deliberately *not* the
  // generation, which a re-read of the same listing bumps as well.
  private listingKey(source: PhotoSource, expandStacks: boolean): string {
    return JSON.stringify([sourceKey(source), this.listing.ordering, this.selectionFilters(expandStacks)]);
  }

  // The switch itself, in one action so the grid never renders a listing halfway
  // between the two - and `resetRows` inside it, which abandons every request the
  // old listing had out.
  @action
  private applyExpandStacks(put: {
    expand: boolean;
    total: number;
    photoTotal: number;
    selection: SelectionRanges;
    focusIndex: number;
    /** Where the reader's own row sits now: its position, and how far into it they were. */
    scrollTo: { position: number; offset: number } | null;
  }): void {
    // Where the reader is, for the case where the other listing cannot say where
    // their row went - the stack they were anchored on has been unstacked, or the
    // top row is one this client never held. `resetRows` puts the scroll back to
    // zero, and being thrown to the top of the collection is far worse than being
    // left at the pixel they were already at.
    const wasAt = this.listing.rail.at;
    this.listingPresenter.setExpandStacks(put.expand);
    this.resetRows();
    // No row of an uncollapsed listing stands for a stack, so there is nothing
    // open and nothing chosen inside a band - and collapsing again, the bands
    // that were open describe positions this listing does not have.
    this.stackActionsPresenter.resetCollection();
    this.listingPresenter.setTotal(put.total, put.photoTotal);
    // Counted already, by this generation's own read of the same collection.
    this.listingPresenter.needsCount = false;
    this.selectionPresenter.replace(put.selection, put.focusIndex);
    this.remember();
    this.rail.scrollTo(put.scrollTo == null ? wasAt : this.listing.contentTopOf(put.scrollTo.position) + put.scrollTo.offset);
  }

  // The row at the top of the viewport and how far into it the reader is, named
  // by a key the other listing can answer for. Null for a row this client is not
  // holding, which leaves the view where it is.
  private anchorKey(): { key: string; offset: number } | null {
    const store = this.listing;
    const row = store.rows.get(store.topPosition);
    if (row == null) return null;
    // No offset in masonry: how far into a block the reader is was measured
    // against that block's real height, and after the re-list every block is back
    // to an estimate. Carried over, a reader 2,500px into a block that laid out at
    // 3,200 would land 2,500px into one estimated at 900 - two blocks past their
    // own photographs.
    if (store.mode === 'masonry') return { key: rowKey(row), offset: 0 };
    const gridRow = Math.floor(store.topPosition / store.columns);
    const drawnAt = displayRowOf(gridRow, store.bands, store.columns) * store.rowHeight;
    return { key: rowKey(row), offset: store.rail.at - drawnAt };
  }

  // What is selected, named by keys the other listing can answer for. Only the
  // rows this client is holding: a selection reaching further is positions into a
  // collection about to be renumbered, and the nearest guess at where those
  // photographs went is how a reader ends up acting on frames they never chose
  // (`rebase`).
  private selectionKeys(): string[] {
    const keys = new Set<string>();
    for (const [index, row] of this.listing.rows) {
      if (this.marks.selection.has(index)) keys.add(rowKey(row));
    }
    // A member picked out of an open band is named by its own id rather than by
    // its stack's: uncollapsed it is a row of the collection like any other, and
    // its siblings are not what the reader chose.
    for (const id of this.marks.selectedMembers) keys.add(id);
    return [...keys];
  }

  async refreshMetadata(target: PhotoTarget): Promise<void> {
    try {
      const { updated } = await photosApi.refreshMetadata(target);
      // This re-reads the RAW header for a whole selection, so every photograph it touched
      // now has a detail here describing what the header said before.
      this.forgetDetails();
      await this.refreshDetail();
      this.toasts.show(PhotosPresenterStrings.refreshedMetadata(updated));
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * A verdict or a rating over the whole selection.
   *
   * The selection survives it, unlike every other bulk action: rating a burst and
   * then picking it is one pass, and a mark takes nothing away to leave the
   * selection describing photographs that are no longer there. What it can do is
   * move them out of the slice being viewed, which is what the re-read is for -
   * and that re-expresses the selection against the new listing itself.
   */
  async markSelection(marks: PhotoMarks): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    try {
      await photosApi.mark(target, marks);
    } catch (err) {
      this.fail(err);
      return;
    }
    await Promise.all([this.refresh(), this.refreshDetail()]);
  }

  async refreshMetadataForSelection(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    await this.refreshMetadata(target);
    this.dropConsumedSelection();
  }

  // The rendition the user asked for, which is also the one to reopen at: which
  // of those two memories it lands in is the setting's business, not this one's
  // (§10.2).
  async chooseRendition(photoId: string, rendition: ViewerRendition): Promise<void> {
    // Before the await, and whether or not anything below changes: pressing the key is the
    // reader asking for that frame, and a frame the stage gave up on has no other way back
    // (`store.retryEpoch`). Asking for the one already on screen is what a reader does when
    // it did not appear, so it counts too.
    this.renditionAsked();
    await this.showRendition(photoId, rendition);
    if (this.viewer.rendition !== rendition) return; // the build failed; nothing to remember
    if (this.settings.viewerRenditionMode !== 'remember_per_photo') {
      // Only where it actually wrote: a pinned mode remembers nothing, so nothing this
      // client is holding was resolved against something that has changed.
      if (await this.settingsPresenter.rememberRendition(rendition)) this.renditionPolicyMoved();
      return;
    }
    if (this.viewer.photoFor(photoId)?.viewer_rendition === rendition) return;
    await this.patch(photoId, { viewer_rendition: rendition });
  }

  @action.bound
  private renditionAsked(): void {
    this.viewerPresenter.renditionAsked();
  }

  /**
   * The setting `shown_rendition` is resolved from has moved, so every answer this client is
   * holding for a photograph other than this one was computed against the old setting.
   *
   * **Dropped, not re-read.** Choosing a rendition is a keypress on a photograph whose two
   * files are both already on screen, and it is the one gesture in the viewer that asks the
   * server for nothing at all - so this cannot cost a request, and none of these answers is
   * needed until the reader steps somewhere. Each is then read as part of opening that
   * photograph, which is what it cost before any of them were remembered.
   */
  @action.bound
  private renditionPolicyMoved(): void {
    this.forgetDetails();
    // The open photograph's is kept, the panels being drawn from it, and `store.rendition`
    // is what answers for it until the step - which is exactly when it goes, below.
    this.staleDetailId = this.viewer.open?.id ?? null;
  }

  // A detail read before the setting moved, still held because its photograph was on screen
  // at the time. Dropped the moment the reader leaves it, so stepping back to it reads the
  // rendition the setting now asks for rather than the one it asked for then.
  private staleDetailId: string | null = null;

  // This photo's render, made again from the RAW rather than served from the file
  // that already exists. For working on the pipeline itself: the file *is* the
  // cache, so a change to a decode setting is invisible on every photo already
  // looked at until something deletes what is there.
  //
  // **Whichever rendition is on screen**, since that is the one being looked at: a reader
  // on Rendered RAW (max quality) who asks for a re-render and gets `full` rebuilt is told
  // the pipeline has not changed, by a picture that was never remade. The camera's JPEG is
  // the RAW's own bytes and has no build to force past, so from there this remakes the
  // render behind it - and nothing at all where the photograph has no render to remake,
  // which is the same answer the menu greys the action out on (`rerenderTarget`).
  async rerenderRenditions(photoId: string): Promise<void> {
    await this.renditionsPresenter.rerender(photoId);
  }

  // The file the camera wrote, which is already on disk and needs no render. Everything
  // else a reader can take away goes through the export dialog, which asks for its own
  // size, format and quality rather than serving the viewer's working copies.
  download(photoId: string, form: 'original'): void {
    this.sharePresenter.download(photoId, form);
  }

  async openWith(photoId: string): Promise<void> {
    await this.sharePresenter.openWith(photoId);
  }

  /**
   * The photograph on screen, into whatever the platform's share sheet offers.
   *
   * One file, at the rendition being looked at: sharing is a gesture about the picture in front
   * of the reader, so which copy it is follows the viewer rather than a second choice. The
   * server hands back a JPEG whichever rendition that is - an application on the other side of
   * a share sheet is as likely to be a decade old as not.
   */
  async share(photoId: string): Promise<void> {
    await this.sharePresenter.share(photoId);
  }

  // Puts a rendition on screen, building it first if it is not on disk.
  private async showRendition(photoId: string, rendition: ViewerRendition): Promise<void> {
    await this.renditionsPresenter.show(photoId, rendition);
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
    this.renditionsPresenter.rebuilt(photoId, stage, version);
  }

  @action.bound
  serverReachable(): void {
    this.viewerPresenter.serverReachable();
  }

  // Reported by the stage when a frame has decoded, so the panel beside it can
  // describe what is on screen rather than what a column claims. Carries which
  // file decoded, because the stage reports once per frame and the panel is read
  // on every render after it.
  @action.bound
  imageShown(photoId: string, rendition: ViewerRendition, width: number, height: number): void {
    this.viewerPresenter.imageShown(photoId, rendition, width, height);
  }

  // Whether a photo is still the one the view is on. Every write that lands after
  // an await has to ask: the store holds one detail and one chosen rendition, so
  // a request that resolves after the user has stepped on would otherwise put the
  // photo they left back on screen, or apply its rendition to the one they are
  // looking at now.
  private isCurrent(photoId: string): boolean {
    return this.viewer.open?.id === photoId;
  }

  // --- detail ---

  async openDetail(photoId: string, from: PhotoSource | null = null): Promise<void> {
    await this.detailPresenter.openDetail(photoId, from);
  }

  async loadEdits(photoId: string): Promise<void> {
    await this.detailPresenter.loadEdits(photoId);
  }

  forgetEdits(photoId: string, orientationChanged = false): void {
    this.detailPresenter.forgetEdits(photoId, orientationChanged);
  }
  async setRating(photoId: string, rating: number): Promise<void> {
    await this.marksPresenter.setRating(photoId, rating);
  }

  async turn(photoId: string, by: 90 | -90): Promise<void> {
    await this.detailPresenter.turn(photoId, by);
  }
  /**
   * @returns whether the write landed. Stack triage needs to know: it advances a
   * round on the strength of a rejection, and `patch` otherwise swallows a failure
   * into a toast, so a session would finish believing frames were rejected that
   * the server never took (§20.2).
   */
  async setTriage(photoId: string, triage: Triage, options: { quiet?: boolean } = {}): Promise<boolean> {
    return this.marksPresenter.setTriage(photoId, triage, options);
  }

  /**
   * Light the verdict just given for long enough to be seen. The viewer steps to the next
   * photograph the instant a verdict lands, so without this the button the reader pressed is
   * already showing the *next* photo's verdict by the time their eye reaches it.
   */
  holdVerdict(triage: Triage | null): void {
    this.marksPresenter.holdVerdict(triage);
  }

  async setNotes(photoId: string, notes: string): Promise<void> {
    await this.marksPresenter.setNotes(photoId, notes);
  }

  // --- keyboard culling ---
  // These act on the focused tile, so the whole cull can happen in the grid
  // without opening each photo.

  // The pointer moving the cursor, which every click does so that the cull keys
  // carry on from what was last touched. It draws nothing: a ring a click left
  // behind outlives the gesture that made it and marks a photograph nobody is
  // about to act on (§18.3.1).
  @action.bound
  focusAt(index: number): void {
    this.selectionPresenter.focusAt(index);
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
    this.selectionPresenter.focusOpenPhoto();
  }

  // The cursor moves without choosing anything: a selection is entered
  // deliberately (§18.3.1), and arrowing through a shoot is browsing. Building one
  // from the keyboard is Space, which toggles without moving.
  @action.bound
  moveFocus(delta: number): void {
    this.selectionPresenter.moveFocus(delta);
  }

  async rateFocused(rating: number): Promise<void> {
    const photo = this.marks.focusedPhoto;
    if (photo == null) return;
    await this.setRating(photo.id, rating);
  }

  async setFocusedTriage(triage: Triage): Promise<void> {
    const photo = this.marks.focusedPhoto;
    if (photo == null) return;
    await this.setTriage(photo.id, triage);
  }

  async togglePickFocused(): Promise<void> {
    const photo = this.marks.focusedPhoto;
    if (photo == null) return;
    // Pressing pick on an already-picked photo clears the verdict, so the same
    // key both sets and undoes it.
    await this.setTriage(photo.id, photo.triage === 'picked' ? 'untriaged' : 'picked');
  }

  async toggleRejectFocused(): Promise<void> {
    const photo = this.marks.focusedPhoto;
    if (photo == null) return;
    await this.setTriage(photo.id, photo.triage === 'rejected' ? 'untriaged' : 'rejected');
  }

  async binFocused(): Promise<void> {
    const photo = this.marks.focusedPhoto;
    if (photo == null || photo.is_deleted) return;
    await this.deletePhotos({ photo_ids: [photo.id] });
  }

  @action.bound
  toggle(index: number): void {
    this.selectionPresenter.toggle(index);
  }

  @action.bound
  extendTo(index: number): void {
    this.selectionPresenter.extendTo(index);
  }

  @action.bound
  selectSpan(span: Span): void {
    this.selectionPresenter.selectSpan(span);
  }

  @action.bound
  selectAll(): void {
    this.selectionPresenter.selectAll();
  }

  @action.bound
  clearSelection(): void {
    this.selectionPresenter.clearSelection();
  }

  @action.bound
  dismissSelection(): void {
    this.selectionPresenter.dismissSelection();
  }

  @action.bound
  showCursor(): void {
    this.selectionPresenter.showCursor();
  }

  private clearSelectedPositions(): void {
    this.selectionPresenter.clearSelectedPositions();
  }

  private dropConsumedSelection(): void {
    this.selectionPresenter.dropConsumedSelection();
  }

  async addSelectedToShoot(shootId: string): Promise<void> {
    await this.bulkPresenter.addSelectedToShoot(shootId);
  }

  async addSelectedToAlbum(albumId: string): Promise<void> {
    await this.bulkPresenter.addSelectedToAlbum(albumId);
  }

  async removeSelectedFromShoot(shootId: string): Promise<void> {
    await this.bulkPresenter.removeSelectedFromShoot(shootId);
  }

  async removeSelectedFromAlbum(albumId: string): Promise<void> {
    await this.bulkPresenter.removeSelectedFromAlbum(albumId);
  }

  async setSelectionAsBanner(collection: { kind: 'shoot' | 'album'; id: string }): Promise<void> {
    await this.bulkPresenter.setSelectionAsBanner(collection);
  }

  async deleteSelected(): Promise<void> {
    await this.bulkPresenter.deleteSelected();
  }

  async restoreSelected(): Promise<void> {
    await this.bulkPresenter.restoreSelected();
  }

  async hidePhotos(target: PhotoTarget, hidden: boolean): Promise<void> {
    await this.bulkPresenter.hidePhotos(target, hidden);
  }

  async hideSelected(hidden: boolean): Promise<void> {
    await this.bulkPresenter.hideSelected(hidden);
  }

  async rebuildGridRenditions(): Promise<void> {
    await this.bulkPresenter.rebuildGridRenditions();
  }
  // A photo whose processing never ran, or failed, has no rendition to serve and
  // nothing queued to change that, so the detail view would sit on "no rendition
  // yet" indefinitely. Builds the one that is actually missing rather than
  // reprocessing from the embedded JPEG: that rebuilds the grid rendition, which
  // is not what the viewer is asking for, so a library that renders would ask
  // again on the next paint and never stop.
  async buildMissingRendition(photoId: string, rendition: Rendition): Promise<void> {
    await this.renditionsPresenter.buildMissing(photoId, rendition);
  }

  private async refreshDetail(activity?: RequestActivity): Promise<void> {
    await this.detailPresenter.refresh(activity);
  }
  async deletePhotos(target: PhotoTarget): Promise<void> {
    await this.bulkPresenter.deletePhotos(target);
  }
  // An action that failed, as opposed to a view that cannot render. store.error
  // is the latter: it explains an empty grid or a missing photo, in place. A
  // failed rebuild or delete leaves the view perfectly renderable, so it belongs
  // in a toast that outlives the click and can be read at leisure.
  private fail(err: unknown): void {
    this.toasts.showError(message(err), detail(err));
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
  async toggleBand(stackId: string, position: number, frames: CompositeKind | null = null): Promise<void> {
    await this.stackActionsPresenter.toggleBand(stackId, position, frames);
  }

  closeBand(stackId: string): void {
    this.stackActionsPresenter.closeBand(stackId);
  }

  async followBand(stackId: string | null): Promise<void> {
    await this.stackActionsPresenter.followBand(stackId);
  }

  async replaceBands(activity: RequestActivity = 'interactive'): Promise<void> {
    await this.stackActionsPresenter.replaceBands(activity);
  }
  @action.bound
  toggleMember(photo: PhotoSummary): void {
    this.selectionPresenter.toggleMember(photo);
  }

  // Shift-click inside an open band. The span is over the band's own order, which
  // is the collection's (`bandScope`), so it reads the way a run of rows does.
  @action.bound
  extendMembersTo(photo: PhotoSummary): void {
    this.selectionPresenter.extendMembersTo(photo);
  }

  @action.bound
  clearMemberSelection(): void {
    this.selectionPresenter.clearMemberSelection();
  }

  async stackSelection(): Promise<void> {
    await this.stackActionsPresenter.stackSelection();
  }

  async mergeSelectionToPanorama(): Promise<void> {
    await this.stackActionsPresenter.mergeSelectionToPanorama();
  }

  async startAssembly(frameIds: string[]): Promise<string | null> {
    return this.stackActionsPresenter.startAssembly(frameIds);
  }

  compositeProgressed(progress: CompositeProgress): void {
    this.stackActionsPresenter.compositeProgressed(progress);
  }

  async unstackSelection(): Promise<void> {
    await this.stackActionsPresenter.unstackSelection();
  }

  async removeSelectedFromStacks(): Promise<void> {
    await this.stackActionsPresenter.removeSelectedFromStacks();
  }
  // The filters a server-side question about this collection has to carry, so
  // that a selection and a position lookup are asking about the same listing. A
  // second copy of this is a position meaning one photograph here and another
  // there (§19.5.1).
  private selectionFilters(expandStacks = this.listing.expandStacks): PhotoSelection['filters'] {
    const source = this.listing.source;
    const f = this.listing.filters;
    return {
      rated: f.rated,
      triage: f.triage,
      is_missing: f.isMissing,
      is_hidden: f.isHidden,
      taken_from: f.takenFrom,
      taken_to: f.takenTo,
      camera_models: f.cameraModels,
      lens_models: f.lensModels,
      match: f.match,
      // Which listing the positions are into, so a selection made on an expanded
      // grid resolves against the same rows it was made from (§19.5.4).
      ...(expandStacks ? { expand_stacks: true } : {}),
      ...(f.search != null && f.search !== '' ? { q: f.search } : {}),
      // Last, because these are what makes the view that view rather than a
      // chip the reader could clear.
      ...viewFilters(source),
    };
  }

  private enqueueWrite<T>(run: () => Promise<T>): Promise<T> {
    const done = this.writing.then(run);
    this.writing = done.catch(() => undefined);
    return done;
  }

  /** Public for the actions a sibling domain owns: eviction is replication's (§7.6). */
  selectionTarget(): PhotoTarget | null {
    const source = this.listing.source;
    if (source == null || !this.marks.hasSelection) return null;
    return {
      selection: {
        scope: scopeOf(source),
        filters: this.selectionFilters(),
        ranges: this.marks.selection.ranges.map((range) => ({ ...range })),
        // Photos picked out of an open band, which have no position to be in a
        // run (§19.6.1). The server takes each photo once, so a member whose
        // stack's row is also selected is not acted on twice.
        members: [...this.marks.selectedMembers],
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
    fields: Parameters<typeof photosApi.update>[1],
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
    fields: Parameters<typeof photosApi.update>[1],
    options: { quiet?: boolean },
  ): Promise<boolean> {
    try {
      const updated = await photosApi.update(photoId, fields);
      // Into the object the panels are already reading, not over it: only the
      // fields that moved then notify, so rating a photo leaves the camera
      // settings and the paths beside it alone. Minus the two a patch cannot
      // change, which arrive as fresh objects every time and would look like a
      // change to whoever reads them - the frame and the rendition panel, for a
      // star. What does move them says so itself (§18.6).
      const { renditions: _renditions, album_ids: _albums, ...changed } = updated;
      this.viewerPresenter.patchPhoto(photoId, changed);
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
      const rowChanged = {
        rating: updated.rating,
        triage: updated.triage,
        // The row answers which rendition to reopen this photo at, so a choice
        // written only to the detail would be forgotten on the step back to it.
        viewer_rendition: updated.viewer_rendition,
        // And which rendition the server resolved from it. A row is listed once and
        // then kept, so without this a pick made in the viewer is still answered by
        // whatever the setting said when its page was fetched - the reader chooses the
        // camera's JPEG, steps on, and is handed the render they just refused.
        shown_rendition: updated.shown_rendition,
        is_edited: updated.is_edited,
      };
      this.listingPresenter.patchPhoto(photoId, rowChanged);
      this.stackActionsPresenter.patchPhoto(photoId, rowChanged);
      // Only the field that changed can move a photo out of the slice being
      // viewed: a rating cannot change triage membership, and a note changes
      // neither. Testing the filters alone re-read the whole page every time a
      // star or a note was touched in the Active view, which is the default.
      // Re-read rather than filtering locally, which would mean a second copy of
      // the server's filter logic to drift out of step.
      const f = this.listing.filters;
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

  private refresh(activity: RequestActivity = 'interactive'): Promise<void> {
    return this.listingPresenter.refresh(activity);
  }

  private async ensureBlocks(blocks: number[]): Promise<void> {
    await this.listingPresenter.ensureBlocks(blocks);
  }

  private resetRows(): void {
    this.listingPresenter.resetRows();
  }

  private beginLoad(source: PhotoSource): void {
    this.listingPresenter.beginLoad(source);
  }

  private remember(): void {
    this.listingPresenter.remember();
  }

  private applyFilters(filters: PhotoFilters): void {
    this.listingPresenter.applyFilters(filters);
  }
  // Deliberately leaves `lastDetailId` alone: it names the previous photo until this one
  // lands, and clearing it made library_id momentarily null, which collapsed the sidebar and
  // title on every next/prev and read as a flash.
  @action.bound
  private beginDetail(photoId: string): void {
    // Left alone when the photo already open is re-opened: the view remounting is
    // not an arrival, and clearing it there would drop the direction of the step
    // that got here before the frame it belongs to has painted.
    const previous = this.viewer.open?.id;
    const lastStep = previous === photoId ? this.viewer.lastStep : this.stepTaken(previous, photoId);
    // Whatever was on screen when the rendition setting moved has been answering from a
    // detail read before it, which only `store.rendition` was covering; opening a photograph
    // is when that stops being true (`renditionPolicyMoved`).
    //
    // **Including the photograph it was itself.** This runs on an open or a step and never on
    // a swap - a swap is `chooseRendition`, which is why the drop can be deferred here at all
    // - so reaching it means the reader has arrived at the photo afresh, and `store.rendition`
    // has just been cleared below. Held back for that one id, a reader who pressed `i`, left
    // for the grid and came back was given the render they had just refused, out of a detail
    // read before they refused it, with nothing to re-read it.
    const staleDetailId = this.staleDetailId;
    this.staleDetailId = null;
    // Per photo, not sticky: the next photo may have nothing cached for the
    // rendition this one was showing, which would be a 404 rather than a picture.
    // Reopening it there is the setting's job, and it builds first.
    this.viewerPresenter.beginDetail(photoId, lastStep, staleDetailId);
  }

  // Off the run, which is the ordering prev/next themselves are read from and the
  // only one a stack's members appear in: the collapsed listing has no row for
  // them (§19.5.3), so a position taken from there is -1 on every step inside a
  // stack and the frames never learn which way to slide. Read now, while both
  // photographs are still in the same window of the run - it is re-fetched around
  // whichever photo is open, so an index kept from an earlier one means nothing.
  private stepTaken(previous: string | undefined, photoId: string): { to: string; direction: 'next' | 'prev' } | null {
    if (previous == null) return null;
    const run = this.viewer.neighbourhood;
    const from = run.findIndex((photo) => photo.id === previous);
    const to = run.findIndex((photo) => photo.id === photoId);
    if (from < 0 || to < 0) return null;
    return { to: photoId, direction: from < to ? 'next' : 'prev' };
  }
}

import { computed, observable } from 'mobx';
import { type Ordering } from '../../../../../src/schemas/common';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { type Span, visibleRows } from '../../../ui/virtual_rows';
import { BAND_COLOURS, type PhotoSource, type ViewMode } from '../photos_store';
import { type Band, type GridSection, rowAt, sectionsIn, totalRows } from './bands';
import {
  BLOCK,
  GRID_GAP,
  LIST_ROW_H,
  MARKS_MIN_TILE,
  MIN_TILE,
  blockTops,
  gridColumns,
  gridRowHeight,
  visibleBlocks,
  zoomOfColumns,
} from './grid_layout';
import { activeFilters, dayDensities, distinctSorted, reachableModels, type ModelPair, type PhotoDay, type PhotoFilters } from './photo_filters';
import { ScrollRailStore } from './scroll_rail_store';
import type { StacksStore } from './stacks_store';

export class ListingStore {
  constructor(private readonly stacks: StacksStore) {}

  // The rows the client is holding, by their position in the whole collection -
  // sparse, because a library runs to hundreds of thousands of photos and only
  // what is near the viewport is ever fetched (§18.3.2).
  //
  // A Map rather than an array for the same reason `selected` is one: mobx
  // tracks `get` per key, so a block landing re-renders the tiles it filled and
  // nothing else, and the row objects themselves are deep observables, so rating
  // or rejecting one photo re-renders that tile alone.
  @observable accessor rows = new Map<number, PhotoSummary>();
  @observable accessor total = 0;
  // Photographs, where `total` is entries (§19.5.1).
  @observable accessor photoTotal = 0;
  @observable accessor source: PhotoSource | null = null;
  @observable accessor loading = false;
  @observable accessor error: string | null = null;
  // Written by the presenter from the scroller's ResizeObserver and its scroll
  // handler. Every question about what is on screen is answered from these, so
  // no render, reaction or scroll frame reads the layout back out of the DOM.
  @observable accessor viewportWidth = 0;
  @observable accessor viewportHeight = 0;
  // Measured pixel height per block, for masonry alone: it packs lines from each
  // photo's own shape, so a block's height is not knowable until it has been
  // laid out. Dropped by a measurement that contradicts them (`measuredWidth`), and
  // by the zoom, the mode switch and a collection replaced under them
  // (`forgetMasonryLayout`).
  @observable accessor blockHeights = new Map<number, number>();
  // The width those heights were laid out at, as the blocks themselves reported
  // it. Not `viewportWidth`, which is the scroller's own observer and lands in the
  // same batch as theirs rather than before it.
  @observable accessor measuredWidth = 0;
  // Which photo a masonry block starts at, where its predecessor has packed its
  // lines and found that the paging boundary falls mid-line (`masonryBlockEnd`).
  // Dropped wherever the packing moves under them - a width, a zoom, a mode switch -
  // being a seam the new layout does not describe.
  @observable accessor blockStarts = new Map<number, number>();
  @observable accessor filters: PhotoFilters = {};
  // Every body/lens pairing the collection on screen holds, which is what the
  // filter menu offers and what decides which of the two lists' rows can be
  // ticked together. Empty until it has been asked for.
  @observable accessor modelPairs: ModelPair[] = [];
  // Every day the collection holds a photograph on, and how many, ascending. Empty
  // until it has been asked for.
  @observable accessor photoDays: PhotoDay[] = [];
  // The collection's own sort, as the server reported serving it. Null until the
  // first page lands, because a default invented here would be a second answer to
  // a question the collection already answers, and the two would disagree the
  // moment either changed (§18.3.1).
  @observable accessor ordering: Ordering | null = null;
  // Minimum tile width in px, driven by the grid's zoom slider.
  @observable accessor tileSize = 240;
  @observable accessor mode: ViewMode = 'masonry';
  // Whether the collection is listed uncollapsed: every frame of every stack in
  // the one stream, with no tile standing for a stack and so no bands (§19.5.4).
  // Nothing in the grid renders from it - a row in hand already says what it is,
  // so a tile and this cannot disagree part-way through a switch.
  @observable accessor expandStacks = false;
  // Whether a tile says which file it is. On by default: a cull is a decision about a
  // photograph, and which one it was is what the reader writes down afterwards.
  @observable accessor showFilenames = true;

  // Where the gallery is inside the collection (§18.3.2). Its own store because a
  // second view scrolls the same collection on the other axis - the viewer's
  // filmstrip - and the rail's recentring is the one piece of this that must not
  // exist twice.
  readonly rail = new ScrollRailStore(
    () => this.contentHeight,
    () => this.viewportHeight,
  );

  /**
   * How many questions are being asked of the collection, counting the verdict set, the
   * rating, each flag, the date range and the search as one apiece rather than one per
   * ticked box - "picks and unrated" is one narrowing, not two.
   *
   * The working set the gallery opens at counts as none of them: it is where the reader
   * starts rather than something they chose, and a badge on it would never come off.
   */
  @computed get activeFilterCount(): number {
    const filters = this.filters;
    const triage = filters.triage ?? [];
    const opening = activeFilters().triage ?? [];
    const isOpening = triage.length === opening.length && opening.every((value) => triage.includes(value));
    return (
      (triage.length > 0 && !isOpening ? 1 : 0) +
      (filters.rated != null ? 1 : 0) +
      (filters.isMissing != null ? 1 : 0) +
      (filters.isHidden === true ? 1 : 0) +
      (filters.takenFrom != null || filters.takenTo != null ? 1 : 0) +
      // One apiece however many bodies are ticked, as the verdict set counts once.
      ((filters.cameraModels?.length ?? 0) > 0 ? 1 : 0) +
      ((filters.lensModels?.length ?? 0) > 0 ? 1 : 0) +
      ((filters.search ?? '') !== '' ? 1 : 0)
    );
  }

  @computed get hasActiveFilters(): boolean {
    const filters = this.filters;
    return (
      filters.rated != null ||
      filters.triage != null ||
      filters.isMissing != null ||
      filters.isHidden === true ||
      filters.takenFrom != null ||
      filters.takenTo != null ||
      (filters.cameraModels?.length ?? 0) > 0 ||
      (filters.lensModels?.length ?? 0) > 0 ||
      (filters.search ?? '') !== ''
    );
  }

  /** How busy each day was, 0..1, for the calendar's dots. */
  @computed get dayDensity(): Map<string, number> {
    return dayDensities(this.photoDays);
  }

  /**
   * The last day the collection holds a photograph on, which is the month the calendar
   * opens at: a shoot from two years ago would otherwise open on this month, empty, and
   * be reached by twenty-four presses of an arrow.
   */
  @computed get lastPhotoDay(): string | undefined {
    return this.photoDays[this.photoDays.length - 1]?.day;
  }

  @computed get firstPhotoDay(): string | undefined {
    return this.photoDays[0]?.day;
  }

  @computed get cameraModelOptions(): string[] {
    return distinctSorted(this.modelPairs.map((pair) => pair.camera_model));
  }

  @computed get lensModelOptions(): string[] {
    return distinctSorted(this.modelPairs.map((pair) => pair.lens_model));
  }

  /**
   * The bodies that can still be ticked, and the lenses.
   *
   * A lens that was never mounted on a ticked body would list nothing, so it is offered
   * greyed rather than as a way to empty the grid. Nothing narrows its own list: ticking a
   * second body is how the first one's is widened.
   *
   * A ticked row stays enabled whatever the other list says, so that a pair the reader
   * arrived at is always one they can take apart again.
   */
  @computed get enabledCameraModels(): Set<string> {
    return new Set([
      ...(this.filters.cameraModels ?? []),
      ...reachableModels(this.modelPairs, 'camera_model', this.filters.lensModels ?? []),
    ]);
  }

  @computed get enabledLensModels(): Set<string> {
    return new Set([
      ...(this.filters.lensModels ?? []),
      ...reachableModels(this.modelPairs, 'lens_model', this.filters.cameraModels ?? []),
    ]);
  }

  // Where each loaded row sits in the collection. The views work in absolute
  // indices - that is what the scroll, the cursor and the viewer's neighbours
  // are all expressed in - and a row only ever knows its own id.
  @computed get indexById(): Map<string, number> {
    const byId = new Map<string, number>();
    for (const [index, row] of this.rows) byId.set(row.id, index);
    return byId;
  }

  /** Position in the collection, or -1 for a photo the client is not holding. */
  indexOf(photoId: string): number {
    return this.indexById.get(photoId) ?? -1;
  }

  /** The grid row for a photo, if this client has it loaded. */
  rowById(photoId: string): PhotoSummary | null {
    const index = this.indexById.get(photoId);
    return index == null ? null : (this.rows.get(index) ?? null);
  }

  // Count first, so a populated grid's dependency on `loading` short-circuits
  // away: it toggles on every block a scroll asks for, and the answer cannot
  // change.
  @computed get isEmpty(): boolean {
    return this.total === 0 && !this.loading;
  }

  @computed get isBin(): boolean {
    return this.source?.kind === 'bin';
  }

  // --- what is on screen ---

  @computed get columns(): number {
    return this.mode === 'list' ? 1 : gridColumns(this.viewportWidth, this.tileSize);
  }

  @computed get maxColumns(): number {
    // Two, not one: a zoom track whose ends meet divides by zero working out where its thumb goes,
    // and the width is 0 until the scroller has been observed once.
    return Math.max(2, gridColumns(this.viewportWidth, MIN_TILE));
  }

  /** The zoom as the slider offers it (`columnsAtZoom`): 0 is as many tiles as the window holds. */
  @computed get zoom(): number {
    return zoomOfColumns(Math.min(this.maxColumns, gridColumns(this.viewportWidth, this.tileSize)), this.maxColumns);
  }

  /** Where the slider's thumb is while a drag has not yet been laid out. */
  @observable accessor zoomDraft: number | null = null;

  // Whether a tile has the width to draw the rating and the verdict in its foot. A list row
  // is the width of the grid whatever the zoom, so only a tile can run out of it.
  @computed get showsMarks(): boolean {
    return this.mode === 'list' || this.tileSize >= MARKS_MIN_TILE;
  }

  // Row pitch for the two modes whose rows are uniform. Masonry's are not, which
  // is why it is laid out block by block instead.
  @computed get rowHeight(): number {
    return this.mode === 'list' ? LIST_ROW_H + GRID_GAP : gridRowHeight(this.viewportWidth, this.columns);
  }

  // Rows of the collection itself, before any stack is opened.
  @computed get gridRowCount(): number {
    return Math.ceil(this.total / this.columns);
  }

  @computed get rowCount(): number {
    return totalRows(this.gridRowCount, this.bands, this.columns);
  }

  /** The open stacks, as the row arithmetic wants them (§19.6). */
  @computed get bands(): Band[] {
    return [...this.stacks.expansions.values()].map((open) => ({ position: open.position, members: open.photos.length }));
  }

  // Which display rows are on screen.
  //
  // Struct, which is the whole reason it is its own computed: the scroll position
  // is sampled once a frame, and comparing the value rather than its inputs is
  // what keeps everything downstream - the sections, the tiles, the blocks to
  // fetch - invalidated per row crossed instead of per frame.
  @computed.struct get visibleSpan(): Span {
    return visibleRows(this.rail.at, this.viewportHeight, this.rowHeight, this.rowCount);
  }

  /**
   * The colour each open stack is drawn in, by stack id.
   *
   * Its tile and its band wear the same one, which is the only thing tying the
   * two together once several stacks on one row are open at once. Numbered from
   * the top of the collection down, so the first one open is always the same
   * colour and the numbering does not depend on the order they were opened in.
   */
  @computed get bandColours(): Map<string, number> {
    const open = [...this.stacks.expansions.values()].sort((a, b) => a.position - b.position);
    return new Map(open.map((expansion, i) => [expansion.stackId, i % BAND_COLOURS]));
  }

  /**
   * The open stacks whose band is drawn joined to their own tile, by stack id.
   *
   * One per row at most: bands from a row sit beneath it in a run, so only the
   * first of them - the lowest position on that row - touches the row it came
   * from. The rest are separated from their tiles by another band and keep a ring
   * of their own; the colour is what ties those to their tiles (§19.6).
   *
   * Masonry answers this per *line* rather than per row, and it does so where the
   * lines are replayed (`tilesFor`); this is for the two modes with a row model.
   */
  @computed get fusedStacks(): Set<string> {
    if (this.mode === 'masonry') return new Set();
    const first = new Map<number, { stackId: string; position: number }>();
    for (const open of this.stacks.expansions.values()) {
      const row = Math.floor(open.position / this.columns);
      const held = first.get(row);
      if (held == null || open.position < held.position) first.set(row, open);
    }
    return new Set([...first.values()].map((open) => open.stackId));
  }

  /**
   * What each visible display row shows: rows of the collection, or the members
   * of one open stack.
   *
   * Consecutive rows of a kind are one section, so a band several rows tall is
   * one bordered box rather than one per row.
   *
   * Positions are in content pixels, which the view turns into rail positions
   * (`ScrollRailStore.positionOf`): held against the rail they would all have to be rewritten
   * every time it was recentred.
   */
  @computed get sections(): GridSection[] {
    return sectionsIn(this.visibleSpan, {
      bands: this.bands,
      columns: this.columns,
      total: this.total,
      rowHeight: this.rowHeight,
      expansionAt: (position) => this.stacks.expansionAt(position),
    });
  }

  /**
   * The stack a tile's badge opens a band from, or null where a tile has none.
   *
   * A stack the filter has left showing one photograph draws an ordinary tile, so
   * the badge is the only way back into its band (§19.6.1).
   */
  stackBadgeId(photo: PhotoSummary): string | null {
    // The setting, which the grid otherwise never renders from (§19.5.4): every row
    // of an uncollapsed listing reads as a stack of one, so without this every
    // member of every stack would wear a badge and open a band the listing has no
    // row for.
    if (this.expandStacks || photo.stack_size > 1) return null;
    // An album's band is scoped to the album as well (§19.5.3), so a lone member's
    // would hold only itself.
    if (this.source?.kind === 'album') return null;
    return photo.stack_id;
  }

  @computed get blockCount(): number {
    return Math.ceil(this.total / BLOCK);
  }

  /**
   * The first photo of a masonry block, and so - read at `block + 1` - the end of
   * the one before it.
   *
   * The paging boundary until the block before has said otherwise, so a block
   * reached without its predecessor renders as it always did and is corrected once
   * that one lands, exactly as an estimated height is.
   */
  startOf(block: number): number {
    return Math.min(this.total, this.blockStarts.get(block) ?? block * BLOCK);
  }

  /** Which masonry block draws a position, the starts having drifted off the paging boundaries. */
  blockOf(position: number): number {
    let block = Math.max(0, Math.min(this.blockCount - 1, Math.floor(position / BLOCK)));
    while (block > 0 && position < this.startOf(block)) block--;
    while (block < this.blockCount - 1 && position >= this.startOf(block + 1)) block++;
    return block;
  }

  // What an unmeasured masonry block is assumed to be worth: the average of the
  // blocks already laid out, or a block of 3:2 frames at this zoom before there
  // are any. Every estimate is replaced by the real height the moment its block
  // reaches the screen.
  @computed get estimatedBlockHeight(): number {
    let total = 0;
    let measured = 0;
    for (const [block, height] of this.blockHeights) {
      // The last block holds whatever is left over, so its height describes a
      // part-block and would drag every estimate below it low. `>=` rather than
      // `===` because heights measured against a longer collection outlive it: an
      // import or a filter moves which block is last, and a part-block left in the
      // average as a full one had a 1,000-photo library describing itself as a
      // tenth of its height.
      if (block >= this.blockCount - 1) continue;
      total += height;
      measured++;
    }
    if (measured > 0) return total / measured;
    const columns = gridColumns(this.viewportWidth, this.tileSize);
    return Math.ceil(BLOCK / columns) * gridRowHeight(this.viewportWidth, columns);
  }

  @computed get blockTops(): number[] {
    return blockTops(this.blockCount, this.blockHeights, this.estimatedBlockHeight);
  }

  /** The scroll's full height, which describes the collection rather than what is loaded. */
  @computed get contentHeight(): number {
    if (this.total === 0) return 0;
    if (this.mode === 'masonry') return (this.blockTops[this.blockCount] ?? 0) - GRID_GAP;
    return this.rowCount * this.rowHeight - GRID_GAP;
  }

  /** Which photo the viewport starts on, as a position in the collection. */
  @computed get topPosition(): number {
    if (this.total === 0) return 0;
    if (this.mode === 'masonry') {
      const { start, end, top, height } = this.blockExtent(this.visibleBlocks.from);
      const through = height > 0 ? Math.max(0, this.rail.at - top) / height : 0;
      return Math.min(this.total - 1, start + Math.round(through * (end - start)));
    }
    const at = rowAt(Math.floor(this.rail.at / this.rowHeight), this.bands, this.columns);
    const gridRow = at.kind === 'grid' ? at.row : Math.floor(at.band.position / this.columns);
    return Math.min(this.total - 1, gridRow * this.columns);
  }

  /** Where a position is drawn, in content pixels, with no band open. */
  contentTopOf(position: number): number {
    if (this.mode !== 'masonry') return Math.floor(position / this.columns) * this.rowHeight;
    // A block's lines are packed from the shapes and not recorded, so where a
    // photo sits inside one is not arithmetic - but the count through the block
    // is close enough to the height through it, and being proportional it says
    // the same thing against a measured block and against an estimated one.
    const { start, end, top, height } = this.blockExtent(this.blockOf(position));
    return top + (end > start ? (position - start) / (end - start) : 0) * height;
  }

  private blockExtent(block: number): { start: number; end: number; top: number; height: number } {
    const top = this.blockTops[block] ?? 0;
    return {
      start: this.startOf(block),
      end: this.startOf(block + 1),
      top,
      height: Math.max(0, (this.blockTops[block + 1] ?? top) - top - GRID_GAP),
    };
  }

  /** Masonry only: the blocks the viewport is over. Struct, as `visibleSpan` is. */
  @computed.struct get visibleBlocks(): Span {
    return visibleBlocks(this.blockTops, this.rail.at, this.viewportHeight);
  }

  /**
   * Masonry only: the blocks whose tiles are mounted, which is a viewport of lead
   * further than the viewport is over.
   *
   * A block below is mounted from the moment its top crosses the viewport's foot,
   * which is a viewport of scrolling in which to fetch its rows. The same lead
   * above is what a block scrolled back up to needs: reached without it, it is
   * drawn from the 3:2 an unheld row waits at and re-packs under the reader as
   * they land.
   */
  @computed.struct get mountedBlocks(): Span {
    const lead = visibleBlocks(this.blockTops, Math.max(0, this.rail.at - this.viewportHeight), this.viewportHeight);
    return { from: lead.from, to: this.visibleBlocks.to };
  }

  /** The photos the grid actually renders, as a half-open span of indices. */
  @computed get visible(): Span {
    if (this.total === 0) return { from: 0, to: 0 };
    if (this.mode === 'masonry') {
      const blocks = this.mountedBlocks;
      return { from: this.startOf(blocks.from), to: this.startOf(blocks.to) };
    }
    // Off the sections rather than off the display rows, because open bands mean
    // the two no longer march together: a screenful of rows can cover fewer
    // photographs than it has cells, and asking for the ones a band displaced off
    // the bottom would fetch blocks nothing is going to show.
    const grid = this.sections.filter((section) => section.kind === 'grid');
    if (grid.length > 0) return { from: grid[0]!.from, to: grid.at(-1)!.to };
    // A band taller than the viewport fills it, so there is no grid section to
    // read a span from. Answering "nothing" there stops every fetch and makes
    // Select visible a no-op, so the stack's own row answers instead - it is the
    // row the reader is inside, and its block is the one they will land on.
    const anchor = this.sections[0];
    const position = anchor?.kind === 'band' ? anchor.position : 0;
    return { from: position, to: Math.min(this.total, position + 1) };
  }
}

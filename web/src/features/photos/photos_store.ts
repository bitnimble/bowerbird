import { computed, observable } from 'mobx';
import type { Ordering, PhotoDetail, PhotoSummary, Rendition, Triage, ViewerRendition } from '../../api/client';
import type { LibrariesStore } from '../libraries/libraries_store';
import type { AppSettingsStore } from '../settings/app_settings_store';
import {
  BLOCK,
  GRID_GAP,
  LIST_ROW_H,
  MAX_SCROLL,
  type Span,
  blockTops,
  gridColumns,
  gridRowHeight,
  visibleBlocks,
  visibleRows,
} from './grid_layout';
import { SelectionRanges } from './selection';

// Which collection the grid is showing. One store serves the library, shoot,
// album, bin and missing views because they differ only in the fetch call.
export type PhotoSource =
  | { kind: 'library'; libraryId: string }
  | { kind: 'shoot'; shootId: string }
  | { kind: 'album'; albumId: string }
  | { kind: 'bin'; libraryId: string }
  | { kind: 'missing'; libraryId: string };

// grid crops every tile to one aspect so rows line up and the eye can scan;
// masonry keeps each photo's own shape; list trades density for metadata.
export type ViewMode = 'grid' | 'masonry' | 'list';

// What the user narrowed the view to. Separate from PhotoSource: the source is
// which collection, this is which slice of it.
export interface PhotoFilters {
  rated?: boolean;
  triage?: Triage[];
  isMissing?: boolean;
  needsTile?: boolean;
  search?: string;
  // Inclusive YYYY-MM-DD bounds from the calendar.
  takenFrom?: string;
  takenTo?: string;
  // 'any' is what the Custom menu sends: picking "picks, unrated and missing"
  // means a photo that is any of those, which as an intersection is empty.
  match?: 'all' | 'any';
}

// Which photo the detail view is on, and what came back for it. A union rather
// than a detail plus two flags: "missing" carries the reason that made it
// missing, so a failure to read one photo cannot be reported as the state of
// another, and no combination of flags can describe a state that cannot happen.
export type OpenPhoto = { id: string; status: 'loading' | 'ready' } | { id: string; status: 'missing'; error: string };

/**
 * The pixels the served image actually decoded to, and which file that was:
 * a reader must not be told the frame on screen is the size of one it is not.
 */
export interface ShownImage {
  photoId: string;
  rendition: ViewerRendition;
  width: number;
  height: number;
}

/** The three stamps every image URL is versioned by. */
export type PhotoStamps = Pick<PhotoSummary, 'tile_built_at' | 'renditions_built_at' | 'date_updated'>;

// Which generation of a file to ask the server for, by the stamp of whatever
// produces its bytes: the import's tile pass for the grid, its rendition pass for
// the viewer's two, and the RAW's own mtime for the camera JPEG, which is lifted
// out of it per request rather than built. Each moves only when its own file did,
// so rebuilding a photo's renditions no longer re-fetches its grid tile.
//
// The row carries all three, so this is known for the frame on screen and for a
// neighbour being warmed alike, it survives a reload, and every client agrees -
// none of which a version a client made up for itself could manage (§13.5). 0
// before that file has ever been written, which leaves the URL plain and the
// ETag in charge.
export function renditionVersion(photo: PhotoStamps | null | undefined, rendition: Rendition | ViewerRendition): number {
  const stamp =
    rendition === 'grid' ? photo?.tile_built_at : rendition === 'embedded' ? photo?.date_updated : photo?.renditions_built_at;
  return stamp == null ? 0 : Date.parse(stamp);
}

// A gallery opens on the working set: everything not yet rejected. Rejecting is
// a decision to stop seeing a frame, so it should leave the view at once. Lives
// here so the presenter's opening state and the "Active" chip cannot disagree.
export function activeFilters(): PhotoFilters {
  return { triage: ['untriaged', 'picked'] };
}

export class PhotosStore {
  // Read-only peers, both for resolving which rendition the viewer opens at
  // without waiting on the photo's detail: the setting says which one the reader
  // wants, the library says which one is certain to have been built.
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly libraries: LibrariesStore,
  ) {}

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
  @observable accessor source: PhotoSource | null = null;
  @observable accessor loading = false;
  @observable accessor error: string | null = null;

  // --- virtual scroll geometry ---
  // Written by the presenter from the scroller's ResizeObserver and its scroll
  // handler. Every question about what is on screen is answered from these, so
  // no render, reaction or scroll frame reads the layout back out of the DOM.
  @observable accessor viewportWidth = 0;
  @observable accessor viewportHeight = 0;
  @observable accessor scrollTop = 0;

  // Measured pixel height per block, for masonry alone: it packs lines from each
  // photo's own shape, so a block's height is not knowable until it has been
  // laid out. Cleared whenever anything that would change that layout changes.
  @observable accessor blockHeights = new Map<number, number>();

  @observable accessor filters: PhotoFilters = {};
  // The collection's own sort, as the server reported serving it. Null until the
  // first page lands, because a default invented here would be a second answer to
  // a question the collection already answers, and the two would disagree the
  // moment either changed (§18.3.1).
  @observable accessor ordering: Ordering | null = null;

  // Minimum tile width in px, driven by the grid's zoom slider.
  @observable accessor tileSize = 240;
  @observable accessor mode: ViewMode = 'grid';

  // Which positions are selected, as runs (§18.3.3). Held by reference: it is an
  // immutable value, so one selection change is one notification. Every mounted
  // tile re-renders on it, which is affordable now that what is mounted is
  // bounded by the viewport rather than by the collection.
  @observable.ref accessor selection: SelectionRanges = SelectionRanges.EMPTY;
  // Anchor for shift-click range selection: the position last toggled on its own.
  @observable accessor lastToggled: number | null = null;

  // Which tile the keyboard is on. -1 means the grid has not been entered yet.
  @observable accessor focusIndex = -1;

  // The rendition picked for this photo, for as long as it is open: the same
  // picture at one of three quality levels, each built on request and cached
  // (§10.2). Null until something is picked, which is the usual state - the
  // setting answers for the rest, and `showing` is what is actually on screen.
  @observable accessor rendition: ViewerRendition | null = null;
  @observable accessor buildingRendition = false;

  // Rebuild a rendition even when one is already on disk. Session-scoped and off
  // by default: it is for working on the pipeline, where the cached copy is the
  // thing standing between a changed setting and seeing what it did.
  @observable accessor forceRebuild = false;

  // The photo the viewer is on and how far its read has got. One value, so it
  // cannot say "loading" and "no such photo" at once, and so "not asked for yet"
  // (null) is distinct from both: the fetch starts in an effect, and the render
  // before it once read as a photo the catalogue does not have.
  @observable.ref accessor open: OpenPhoto | null = null;
  // The last detail that arrived, which is the *previous* photo's until this
  // one's read lands - deliberately, so the rail and the panels do not collapse
  // on every step. Nothing should read it without saying which photo it wants,
  // which is what `detailFor` is for.
  //
  // Deep, not by reference: five panels read different parts of this, and a
  // replaced object notifies all of them. Rating a photo would re-render the
  // camera settings and the file paths beside it, for the same reason the grid
  // keeps its row objects rather than remapping them (`reconcile`).
  @observable accessor loadedDetail: PhotoDetail | null = null;
  @observable accessor notesSavedAt: number | null = null;
  // What the viewer actually has on screen, measured off the decoded image
  // rather than taken from a column, which is the question a reader judging
  // sharpness is asking. Null until something decodes, and replaced rather than
  // cleared: it names the frame it measured, so `shownImageOf` can drop it for a
  // photo it is not about without anything having to remember to clear it - a
  // clear on the step reads as "loading" for good on any re-open that does not
  // decode a fresh frame.
  @observable.ref accessor shownImage: ShownImage | null = null;

  // Bumped whenever the event stream connects, which is the one signal a client
  // gets that the server is up. A frame that failed is never asked for again on
  // its own - the URL only moves when the file behind it is rebuilt - so a
  // restart mid-request left the stage blank for the life of the page.
  @observable accessor serverEpoch = 0;

  // The decoded size of the frame this view is asking about, or null when what
  // decoded last was some other photo or rendition.
  shownImageOf(photoId: string, rendition: ViewerRendition): ShownImage | null {
    const shown = this.shownImage;
    return shown?.photoId === photoId && shown.rendition === rendition ? shown : null;
  }

  // This photo's detail, or null while it is still the one before it. Every
  // consumer needs this check and none of them can be trusted to remember it:
  // the store holds one detail, the view holds another photo's id, and the two
  // disagree for the length of a fetch.
  detailFor(photoId: string): PhotoDetail | null {
    return this.loadedDetail?.id === photoId ? this.loadedDetail : null;
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

  // As much of a photo as the client has: the grid row, or the detail when there
  // is no row (a deep link, or a photo scrolled far enough past to be dropped).
  // Enough for a verdict, a rating and the shape the viewer lays itself out
  // against, all of which the row already carries - so none of them wait on the
  // fetch.
  photoFor(photoId: string): PhotoSummary | null {
    return this.rowById(photoId) ?? this.detailFor(photoId);
  }

  // For a photo the view knows only by id - the neighbours the viewer warms.
  // Anything holding the row itself reads `renditionVersion` off it directly,
  // which is both cheaper and narrower to observe.
  renditionVersionOf(photoId: string | null, rendition: Rendition | ViewerRendition): number {
    if (photoId == null) return 0;
    return renditionVersion(this.photoFor(photoId), rendition);
  }

  @computed get selectionCount(): number {
    return this.selection.size;
  }

  @computed get hasSelection(): boolean {
    return this.selection.size > 0;
  }

  /** Whether every photo in the collection is selected, which is what "Select all" leaves behind. */
  @computed get allSelected(): boolean {
    return this.total > 0 && this.selection.size === this.total;
  }

  // Count first, so a populated grid's dependency on `loading` short-circuits
  // away: it toggles on every block a scroll asks for, and the answer cannot
  // change.
  @computed get isEmpty(): boolean {
    return this.total === 0 && !this.loading;
  }

  @computed get focusedPhoto(): PhotoSummary | null {
    return this.rows.get(this.focusIndex) ?? null;
  }

  @computed get isBin(): boolean {
    return this.source?.kind === 'bin';
  }

  // The shell reads this rather than detail?.library_id. As a computed it only
  // notifies when the *library* changes, so stepping through photos in one
  // library never re-renders the rail or the title bar.
  @computed get detailLibraryId(): string | null {
    return this.loadedDetail?.library_id ?? null;
  }

  // The open photo as the client already knows it: the row the grid loaded, or
  // the last detail when there is no row to have (a deep link, before the
  // collection behind it is fetched). Everything the viewer has to decide before
  // its own fetch returns is answered from here.
  @computed get openPhoto(): PhotoSummary | null {
    const id = this.open?.id;
    return id == null ? null : this.photoFor(id);
  }

  // What the open photo's library builds on import: it serves the camera's JPEG
  // or it renders. The server names this on the detail, but it is a property of
  // the *library*, and the library list is loaded for the rail long before any
  // photo is opened - so it is read from the row the grid already holds. Taken
  // off the detail it was a fetch behind, which is what made the viewer paint a
  // render for a reader set to the camera's JPEG and swap it out a moment later;
  // and in an album spanning two libraries it was the previous photo's answer.
  @computed get defaultRendition(): ViewerRendition {
    const library = this.libraries.byId.get(this.openPhoto?.library_id ?? '');
    // Unknown only until the collection loads, and the camera's JPEG is the one
    // rendition every photo has, so it is the safe answer to guess with.
    return library?.rendition_source === 'render' ? 'full' : 'embedded';
  }

  // What the setting says to open at. Null only when nothing has been chosen for
  // it to remember: the per-photo memory is on the row like everything else the
  // first frame needs, so "last used per photo" no longer has to wait for the
  // detail and paint the library's default in the meantime.
  @computed get preferredRendition(): ViewerRendition | null {
    const mode = this.settings.viewerRenditionMode;
    if (mode === 'remember') return this.settings.lastViewerRendition;
    if (mode === 'remember_per_photo') return this.openPhoto?.viewer_rendition ?? null;
    return mode;
  }

  // The rendition on screen. Answered from the setting wherever it can be, so
  // stepping to the next photo asks for the file the reader actually wants on
  // the first frame instead of painting the library's default and swapping.
  @computed get showing(): ViewerRendition {
    if (this.rendition != null) return this.rendition;
    const preferred = this.preferredRendition;
    return preferred != null && this.isAlwaysBuilt(preferred) ? preferred : this.defaultRendition;
  }

  // Exists for every photo in the library, so it can be asked for before that
  // photo's own detail says whether it does: the camera's JPEG is extracted from
  // the RAW on demand, and the library's default is built on import. The other
  // two are built on request, and asking early is a 404, not a picture.
  isAlwaysBuilt(rendition: ViewerRendition): boolean {
    return rendition === 'embedded' || rendition === this.defaultRendition;
  }

  @computed get hasActiveFilters(): boolean {
    const f = this.filters;
    return (
      f.rated != null ||
      f.triage != null ||
      f.isMissing != null ||
      f.needsTile != null ||
      f.takenFrom != null ||
      f.takenTo != null ||
      (f.search ?? '') !== ''
    );
  }

  // --- what is on screen ---

  @computed get columns(): number {
    return this.mode === 'list' ? 1 : gridColumns(this.viewportWidth, this.tileSize);
  }

  // Row pitch for the two modes whose rows are uniform. Masonry's are not, which
  // is why it is laid out block by block instead.
  @computed get rowHeight(): number {
    return this.mode === 'list' ? LIST_ROW_H + GRID_GAP : gridRowHeight(this.viewportWidth, this.columns);
  }

  @computed get rowCount(): number {
    return Math.ceil(this.total / this.columns);
  }

  @computed get blockCount(): number {
    return Math.ceil(this.total / BLOCK);
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
      // part-block and would drag every estimate below it low.
      if (block === this.blockCount - 1) continue;
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

  /** How tall the scroller actually is, which past `MAX_SCROLL` is not how tall the collection is. */
  @computed get scrollHeight(): number {
    return Math.min(this.contentHeight, MAX_SCROLL);
  }

  // Scroll pixels per content pixel: 1 until the collection is taller than a
  // browser will scroll, and below 1 after that. Everything the grid lays out is
  // in content pixels; only the scroller itself is in scroll pixels.
  @computed get scrollScale(): number {
    const content = this.contentHeight - this.viewportHeight;
    if (content <= 0 || this.contentHeight <= MAX_SCROLL) return 1;
    return (this.scrollHeight - this.viewportHeight) / content;
  }

  /** Where the viewport is in the collection, in content pixels. */
  @computed get virtualTop(): number {
    return this.scrollTop / this.scrollScale;
  }

  /** A position in content pixels, as a position inside the scroller. */
  domTop(contentTop: number): number {
    return this.scrollTop - (this.virtualTop - contentTop);
  }

  /** Masonry only: the blocks whose tiles are mounted. */
  @computed get visibleBlocks(): Span {
    return visibleBlocks(this.blockTops, this.virtualTop, this.viewportHeight);
  }

  /** The photos the grid actually renders, as a half-open span of indices. */
  @computed get visible(): Span {
    if (this.total === 0) return { from: 0, to: 0 };
    if (this.mode === 'masonry') {
      const blocks = this.visibleBlocks;
      return { from: blocks.from * BLOCK, to: Math.min(this.total, blocks.to * BLOCK) };
    }
    const rows = visibleRows(this.virtualTop, this.viewportHeight, this.rowHeight, this.rowCount);
    return { from: rows.from * this.columns, to: Math.min(this.total, rows.to * this.columns) };
  }

  /** Where the rendered window sits inside the scroller (uniform modes). */
  @computed get visibleTop(): number {
    return this.domTop(Math.floor(this.visible.from / this.columns) * this.rowHeight);
  }

  // Where the scroll has to be for the keyboard cursor to be on screen, or null
  // when it already is. Answered here rather than by asking the focused tile to
  // scroll itself into view: key repeat outruns rendering, so the cursor lands
  // several rows outside the window it was moved from, and a tile that was never
  // mounted cannot scroll anything - the cull simply lost sight of the cursor.
  @computed get focusScrollTop(): number | null {
    if (this.focusIndex < 0 || this.total === 0) return null;
    // Answered in scroll pixels, because it is assigned straight to the element.
    const scrolled = (contentTop: number): number => Math.max(0, contentTop) * this.scrollScale;
    if (this.mode === 'masonry') {
      // No row arithmetic to land on, so this goes as far as the block: within
      // one, the tile is mounted and near enough.
      const block = Math.floor(this.focusIndex / BLOCK);
      const { from, to } = this.visibleBlocks;
      return block >= from && block < to ? null : scrolled(this.blockTops[block] ?? 0);
    }
    const top = Math.floor(this.focusIndex / this.columns) * this.rowHeight;
    // The cell, not the row pitch: the gap under it is not part of the tile, and
    // scrolling to clear it would overshoot by one gap every time.
    const bottom = top + this.rowHeight - GRID_GAP;
    if (top < this.virtualTop) return scrolled(top);
    if (bottom > this.virtualTop + this.viewportHeight) return scrolled(bottom - this.viewportHeight);
    return null;
  }

  // Which blocks have to be in memory. What is on screen, plus the block either
  // side of the photo the viewer is on, so stepping past the end of the grid's
  // window is a fetch rather than a dead arrow.
  //
  // Block 0 whenever nothing is loaded, because the collection's size is itself
  // something only a request can answer.
  @computed get neededBlocks(): number[] {
    if (this.total === 0) return [0];
    const blocks = new Set<number>();
    const { from, to } = this.visible;
    for (let index = from; index < to; index += BLOCK) blocks.add(Math.floor(index / BLOCK));
    if (to > from) blocks.add(Math.floor((to - 1) / BLOCK));
    const open = this.detailIndex;
    if (open >= 0) for (const index of [open - 1, open, open + 1]) blocks.add(Math.floor(Math.max(0, index) / BLOCK));
    return [...blocks].filter((block) => block >= 0 && block < this.blockCount).sort((a, b) => a - b);
  }

  // --- the open photo's neighbours ---

  // Position of the open photo in the collection, so the detail view can step to
  // its neighbours. Off the photo that was asked for, not the detail on hand:
  // that is still the previous photo until the fetch lands, and stepping faster
  // than it does made the arrow keys offer the neighbours of the frame before -
  // so a press navigated to the photo already open and did nothing.
  @computed get detailIndex(): number {
    const id = this.open?.id;
    return id == null ? -1 : this.indexOf(id);
  }

  @computed get prevPhotoId(): string | null {
    const i = this.detailIndex;
    return i > 0 ? (this.rows.get(i - 1)?.id ?? null) : null;
  }

  @computed get nextPhotoId(): string | null {
    const i = this.detailIndex;
    return i >= 0 && i < this.total - 1 ? (this.rows.get(i + 1)?.id ?? null) : null;
  }
}

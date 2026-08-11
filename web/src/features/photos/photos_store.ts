import { computed, observable } from 'mobx';
import type { Ordering, PhotoDetail, PhotoSummary, Rendition, Triage, ViewerRendition } from '../../api/client';
import type { LibrariesStore } from '../libraries/libraries_store';
import type { AppSettingsStore } from '../settings/app_settings_store';
import { type Span, visibleRows } from '../../ui/virtual_rows';
import {
  BLOCK,
  GRID_GAP,
  LIST_ROW_H,
  anchorLimit,
  blockTops,
  gridColumns,
  gridRowHeight,
  railHeight,
  visibleBlocks,
} from './grid_layout';
import { SelectionRanges } from './selection';
import { type Band, displayRowOf, rowAt, runStart, totalRows } from './bands';

/** How many colours open stacks are told apart by before they repeat (`[data-band]`). */
export const BAND_COLOURS = 3;

/** A stack the reader has opened, and the members it is showing. */
export interface Expansion {
  stackId: string;
  /** Where the stack's own tile sits in the collapsed collection. */
  position: number;
  photos: PhotoSummary[];
}

/**
 * A run of display rows showing one kind of thing.
 *
 * `key` names the run rather than the window over it, so scrolling re-positions
 * the element React already has instead of replacing it: a new key unmounts every
 * tile in the run, which throws away each one's decoded image and re-requests it.
 */
export type GridSection =
  | { kind: 'grid'; key: string; top: number; from: number; to: number }
  | { kind: 'band'; key: string; top: number; stackId: string; position: number; photos: PhotoSummary[] };

// Which collection the grid is showing. One store serves the library, shoot,
// album, bin and missing views because they differ only in the fetch call.
export type PhotoSource =
  | { kind: 'library'; libraryId: string }
  | { kind: 'shoot'; shootId: string }
  | { kind: 'album'; albumId: string }
  | { kind: 'bin'; libraryId: string }
  | { kind: 'missing'; libraryId: string };

/** What names one collection, and so tells two of them apart. */
export function sourceKey(source: PhotoSource): string {
  switch (source.kind) {
    case 'library':
      return `library.${source.libraryId}`;
    case 'shoot':
      return `shoot.${source.shootId}`;
    case 'album':
      return `album.${source.albumId}`;
    case 'bin':
      return `bin.${source.libraryId}`;
    case 'missing':
      return `missing.${source.libraryId}`;
  }
}

/** Where a collection's own grid lives. */
export function collectionPath(source: PhotoSource): string {
  switch (source.kind) {
    case 'shoot':
      return `/shoots/${source.shootId}`;
    case 'album':
      return `/albums/${source.albumId}`;
    case 'bin':
      return `/libraries/${source.libraryId}/bin`;
    // The missing view has no grid route of its own, so it leaves by the library's.
    case 'library':
    case 'missing':
      return `/libraries/${source.libraryId}`;
  }
}

// The viewer and a triage session are nested under the collection they were
// opened from: a photo is in a shoot or an album as much as it is in a library,
// and one flat route cannot say which of them the reader is in. Without that a
// reload leaves by the wrong grid and steps through the wrong run.
export function photoPath(photoId: string, source: PhotoSource | null): string {
  return source == null ? `/photos/${photoId}` : `${collectionPath(source)}/photos/${photoId}`;
}

export function triagePath(stackId: string, source: PhotoSource | null): string {
  const stack = `/stacks/${stackId}/triage`;
  return source == null ? stack : `${collectionPath(source)}${stack}`;
}

/** The collection a nested viewer or triage URL sits under. */
export function sourceOfPath(pathname: string): PhotoSource | null {
  const [, collection, id, bin] = /^\/(libraries|shoots|albums)\/([^/]+)(\/bin)?\//.exec(pathname) ?? [];
  if (id == null) return null;
  if (collection === 'shoots') return { kind: 'shoot', shootId: id };
  if (collection === 'albums') return { kind: 'album', albumId: id };
  return bin == null ? { kind: 'library', libraryId: id } : { kind: 'bin', libraryId: id };
}

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

/** How close to an end of the run the reader may get before it is re-centred. */
const NEIGHBOUR_MARGIN = 10;

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

  // The box the detail view's stage and panels share, written by the presenter
  // from a ResizeObserver. Which edge the panels take is a question about this
  // box (`panelEdge`), and it is never read back out of the DOM.
  @observable accessor detailWidth = 0;
  @observable accessor detailHeight = 0;

  // Where the scroller is scrolled to, inside a rail that is `RAIL_HEIGHT` tall
  // however long the collection is. The single truth for the element's `scrollTop`
  // in both directions: the scroll handler samples into it, and everything that
  // moves the reader writes it and lets the view follow (§18.3.2).
  @observable accessor railTop = 0;
  // Which content pixel the rail's origin sits at. The reader's position in the
  // collection is `anchorTop + railTop`, and moving one while moving the other
  // the opposite way is how the scroller is rewritten without the view moving.
  //
  // Raw: read it through `anchorTop`, which clamps it to a collection that may
  // have shrunk under it since - a band closing, a masonry block measuring
  // shorter than it was estimated at.
  @observable accessor railAnchor = 0;

  // Measured pixel height per block, for masonry alone: it packs lines from each
  // photo's own shape, so a block's height is not knowable until it has been
  // laid out. Cleared whenever anything that would change that layout changes.
  @observable accessor blockHeights = new Map<number, number>();

  // The stacks the reader has expanded, keyed by stack id (§19.6).
  //
  // Keyed by the stack rather than by the position it was opened at, because the
  // position is a coordinate that a re-order or an import moves: a band survives
  // those and has its position recomputed, rather than being closed because the
  // collection changed underneath it.
  @observable accessor expansions = new Map<string, Expansion>();

  // Where an open stack's tile sits on its masonry line, by stack id: the offset and
  // width its band cuts the gap in its top edge from, and the height its band caps
  // its own rows against (§19.6).
  //
  // Measured, and the only geometry in the grid that is. A masonry line grows its
  // tiles from their own shapes *or* hands the slack to a spacer depending on what
  // follows the line, so where a tile ended up on one is not arithmetic the way a
  // column is - the same reason a masonry block's height is measured rather than
  // computed (§18.3.2). One tile per open stack, and only while it is open.
  @observable accessor stackTileBoxes = new Map<string, { x: number; width: number; height: number }>();

  // Which members of open bands are selected, by id.
  //
  // Ids rather than positions, and legitimately so: the listing is collapsed, so
  // the server numbers one row per stack and a member has no position at all. The
  // rule the virtual grid enforces is that an id must never stand in for an
  // *unloaded* position, and a band's members are loaded, on screen, and few.
  @observable accessor selectedMembers = new Set<string>();

  @observable accessor filters: PhotoFilters = {};
  // The collection's own sort, as the server reported serving it. Null until the
  // first page lands, because a default invented here would be a second answer to
  // a question the collection already answers, and the two would disagree the
  // moment either changed (§18.3.1).
  @observable accessor ordering: Ordering | null = null;

  // Minimum tile width in px, driven by the grid's zoom slider.
  @observable accessor tileSize = 240;
  @observable accessor mode: ViewMode = 'grid';

  // Whether the collection is listed uncollapsed: every frame of every stack in
  // the one stream, with no tile standing for a stack and so no bands (§19.5.4).
  // Nothing in the grid renders from it - a row in hand already says what it is,
  // so a tile and this cannot disagree part-way through a switch.
  @observable accessor expandStacks = false;

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
  // The renditions being built right now, as `photoId:rendition`. One set for
  // both ways a build starts - the reader choosing one that is not on disk, and
  // the stage meeting a 404 on the one the photo opened at - because the stage
  // is covered while either runs and a single flag let whichever finished first
  // uncover a build the other still had going.
  //
  // It is also what stops a stage that fails, remounts and fails again from
  // queueing the same job on every report.
  @observable accessor building: ReadonlySet<string> = new Set();

  /** Whether a build is running for the photo the viewer is on, which is what covers its stage. */
  @computed get buildingRendition(): boolean {
    const photoId = this.open?.id;
    if (photoId == null) return false;
    for (const key of this.building) if (key.startsWith(`${photoId}:`)) return true;
    return false;
  }

  // Rebuild a rendition even when one is already on disk. Session-scoped and off
  // by default: it is for working on the pipeline, where the cached copy is the
  // thing standing between a changed setting and seeing what it did.
  @observable accessor forceRebuild = false;

  // The photo the viewer is on and how far its read has got. One value, so it
  // cannot say "loading" and "no such photo" at once, and so "not asked for yet"
  // (null) is distinct from both: the fetch starts in an effect, and the render
  // before it once read as a photo the catalogue does not have.
  @observable.ref accessor open: OpenPhoto | null = null;
  // Which way the reader arrived at the photo named here, so the stage can slide
  // its frames the way they moved. Recorded when the step is taken rather than
  // worked out afterwards from where the two photographs sit: the run is
  // re-centred as the reader nears its edge, and positions read from two
  // different windows of it do not compare.
  @observable.ref accessor lastStep: { to: string; direction: 'next' | 'prev' } | null = null;
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
  // Every frame the viewer has decoded for the photo it is on, measured off the
  // image rather than taken from a column, which is the question a reader judging
  // sharpness is asking. In the order they first arrived, which is also the order
  // the stage mounts them in.
  //
  // All of them rather than the last one: the renditions a photo has shown stay
  // mounted, so going back to one is an opacity change with no decode - and with
  // nothing decoding there is nothing to report a size, so the last-one-wins slot
  // this used to be left the panel reading "loading" for as long as the reader
  // stayed on the frame they had returned to.
  //
  // Replaced rather than cleared: each entry names the photo it measured, so a
  // step drops the previous photo's without anything having to remember to - a
  // clear on the step reads as "loading" for good on any re-open that does not
  // decode a fresh frame.
  @observable.ref accessor shownImages: readonly ShownImage[] = [];

  // The run of photographs around the open one, in the collection's order and
  // **uncollapsed** (§19.5.3). Rows rather than ids: a warmed neighbour is asked
  // for at the URL its own stamps version, so an id alone would paint one file
  // and fetch another the moment the row arrived.
  //
  // Nothing in here is a position. The grid's numbering is over the collapsed
  // listing and is untouched by any of it.
  @observable.ref accessor neighbourhood: PhotoSummary[] = [];

  // Bumped whenever the event stream connects, which is the one signal a client
  // gets that the server is up. A frame that failed is never asked for again on
  // its own - the URL only moves when the file behind it is rebuilt - so a
  // restart mid-request left the stage blank for the life of the page.
  @observable accessor serverEpoch = 0;

  // The decoded size of the frame this view is asking about, or null when that
  // frame has not decoded for this photo.
  shownImageOf(photoId: string, rendition: ViewerRendition): ShownImage | null {
    return this.shownImages.find((shown) => shown.photoId === photoId && shown.rendition === rendition) ?? null;
  }

  // The renditions of this photo that are decoded and mounted, in the order they
  // arrived. The stage keeps every one of them, so the picker is a choice between
  // frames the page already holds rather than a reason to fetch one again.
  renditionsShownOf(photoId: string): ViewerRendition[] {
    return this.shownImages.filter((shown) => shown.photoId === photoId).map((shown) => shown.rendition);
  }

  // This photo's detail, or null while it is still the one before it. Every
  // consumer needs this check and none of them can be trusted to remember it:
  // the store holds one detail, the view holds another photo's id, and the two
  // disagree for the length of a fetch.
  detailFor(photoId: string): PhotoDetail | null {
    return this.loadedDetail?.id === photoId ? this.loadedDetail : null;
  }

  /** Which way the reader arrived at this photo, or null if they did not step to it. */
  stepTo(photoId: string): 'next' | 'prev' | null {
    const step = this.lastStep;
    return step?.to === photoId ? step.direction : null;
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
    // The run last, after the detail: a patched detail is re-read on every write,
    // where a run row is only replaced when the run is re-fetched, so putting it
    // first would show a verdict reverting on the photograph it was just set on.
    return this.rowById(photoId) ?? this.memberById(photoId) ?? this.detailFor(photoId) ?? this.neighbourById(photoId);
  }

  /** A photo held only as part of the viewer's run - a stack member, or one off-screen. */
  neighbourById(photoId: string): PhotoSummary | null {
    return this.neighbourhood.find((photo) => photo.id === photoId) ?? null;
  }

  /**
   * The photographs a stack lies between, as the run currently has them.
   *
   * Null on a side where the run does not reach past the stack - the collection
   * ends there, or the window does. A caller can hand both to a range and get the
   * stack back without knowing the collection's ordering.
   */
  boundsOfStack(stackId: string): { from: string | null; to: string | null } {
    const first = this.neighbourhood.findIndex((photo) => photo.stack_id === stackId);
    if (first < 0) return { from: null, to: null };
    // The last member anywhere in the run, not the end of the first unbroken block
    // of them: nothing requires a stack's photographs to be adjacent in the
    // collection, and a stack made by hand out of frames taken hours apart is not.
    // `lastIndexOf` rather than `findLastIndex`, which is ES2023 and outside this
    // project's lib.
    const last = this.neighbourhood.map((photo) => photo.stack_id).lastIndexOf(stackId);
    return {
      from: this.neighbourhood[first - 1]?.id ?? null,
      to: this.neighbourhood[last + 1]?.id ?? null,
    };
  }

  /**
   * A photo held only as a member of an open band.
   *
   * A collapsed listing has no row for a stack's members (§19.5.1), so without
   * this every control that starts by locating the photo - rating, the triage
   * verdicts - silently does nothing on a band tile while appearing to work.
   */
  memberById(photoId: string): PhotoSummary | null {
    for (const open of this.expansions.values()) {
      const found = open.photos.find((photo) => photo.id === photoId);
      if (found != null) return found;
    }
    return null;
  }

  // For a photo the view knows only by id - the neighbours the viewer warms.
  // Anything holding the row itself reads `renditionVersion` off it directly,
  // which is both cheaper and narrower to observe.
  renditionVersionOf(photoId: string | null, rendition: Rendition | ViewerRendition): number {
    if (photoId == null) return 0;
    return renditionVersion(this.photoFor(photoId), rendition);
  }

  // Positions and members together: they are one selection, and an action reaches
  // both (§19.6.1). Entries, so a stack counts once here whatever it holds -
  // which is the question the gestures ask, and the one "Stack" needs two of.
  @computed get selectedEntries(): number {
    return this.selection.size + this.selectedMembers.size;
  }

  /**
   * How many photographs the selection stands for.
   *
   * A selected stack row stands for its whole stack, and that is what the server
   * resolves it to (§19.6.1) - so counting it as one described a smaller action
   * than the one about to run.
   *
   * Exact for anything the reader picked out, since a tile has to be on screen to
   * be clicked and its row carries `stack_size`. A selection reaching rows this
   * client has never held - Select all, a shift-click over a block that has since
   * been evicted - counts those one apiece, so the number is a floor there and
   * climbs as the rows load; hence "all selected" rather than a count when it is
   * the whole collection.
   */
  @computed get selectionCount(): number {
    let count = this.selection.size;
    for (const [index, row] of this.rows) {
      if (row.stack_size > 1 && this.selection.has(index)) count += row.stack_size - 1;
    }
    for (const open of this.expansions.values()) {
      // Its row being selected already counted every member of it.
      if (this.selection.has(open.position)) continue;
      count += open.photos.filter((photo) => this.selectedMembers.has(photo.id)).length;
    }
    return count;
  }

  @computed get hasSelection(): boolean {
    return this.selectedEntries > 0;
  }

  /** Whether every photo in the collection is selected, which is what "Select all" leaves behind. */
  @computed get allSelected(): boolean {
    return this.total > 0 && this.selection.size === this.total && this.selectedMembers.size === 0;
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

  /**
   * The file paths of the selected rows this client is actually holding.
   *
   * A **sample**, not the answer: a selection reaches rows that were never
   * loaded or have since been evicted, so absence from here means "not seen"
   * rather than "not selected". Only good for a guard that must not block what
   * it cannot see - the server is what refuses.
   */
  @computed get selectedLoadedPaths(): string[] {
    const paths: string[] = [];
    for (const [index, row] of this.rows) if (this.selection.has(index)) paths.push(row.file_path);
    for (const open of this.expansions.values()) {
      for (const photo of open.photos) if (this.selectedMembers.has(photo.id)) paths.push(photo.file_path);
    }
    return paths;
  }

  // The shell reads this rather than detail?.library_id. As a computed it only
  // notifies when the *library* changes, so stepping through photos in one
  // library never re-renders the rail or the title bar.
  @computed get detailLibraryId(): string | null {
    return this.loadedDetail?.library_id ?? null;
  }

  // Where leaving the viewer goes, and what to call it: the collection the photo
  // was opened from, so a shoot or an album returns to itself rather than to the
  // whole library. Struct, so stepping between photos of one collection does not
  // re-render the bar the button sits in.
  @computed.struct get openedFrom(): { path: string; label: string } {
    const source = this.source;
    if (source == null) {
      // A deep link, for the moment before the library it loads behind itself
      // becomes the collection.
      return { path: this.detailLibraryId == null ? '/' : `/libraries/${this.detailLibraryId}`, label: 'Library' };
    }
    const label = source.kind === 'shoot' ? 'Shoot' : source.kind === 'album' ? 'Album' : source.kind === 'bin' ? 'Bin' : 'Library';
    return { path: collectionPath(source), label };
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

  // Rows of the collection itself, before any stack is opened.
  @computed get gridRowCount(): number {
    return Math.ceil(this.total / this.columns);
  }

  @computed get rowCount(): number {
    return totalRows(this.gridRowCount, this.bands, this.columns);
  }

  /** The open stacks, as the row arithmetic wants them (§19.6). */
  @computed get bands(): Band[] {
    return [...this.expansions.values()].map((open) => ({ position: open.position, members: open.photos.length }));
  }

  // Which display rows are on screen.
  //
  // Struct, which is the whole reason it is its own computed: the scroll position
  // is sampled once a frame, and comparing the value rather than its inputs is
  // what keeps everything downstream - the sections, the tiles, the blocks to
  // fetch - invalidated per row crossed instead of per frame.
  @computed.struct get visibleSpan(): Span {
    return visibleRows(this.virtualTop, this.viewportHeight, this.rowHeight, this.rowCount);
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
    const open = [...this.expansions.values()].sort((a, b) => a.position - b.position);
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
    const first = new Map<number, Expansion>();
    for (const open of this.expansions.values()) {
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
   * (`railPositionOf`): held against the rail they would all have to be rewritten
   * every time it was recentred.
   */
  @computed get sections(): GridSection[] {
    const span = this.visibleSpan;
    const sections: GridSection[] = [];
    for (let display = span.from; display < span.to; display++) {
      const at = rowAt(display, this.bands, this.columns);
      const last = sections.at(-1);
      if (at.kind === 'grid') {
        const from = at.row * this.columns;
        const to = Math.min(this.total, from + this.columns);
        if (last?.kind === 'grid' && last.to === from) last.to = to;
        else
          sections.push({
            kind: 'grid',
            key: `grid-${runStart(at.row, this.bands, this.columns)}`,
            top: display * this.rowHeight,
            from,
            to,
          });
        continue;
      }
      const open = this.expansionAt(at.band.position);
      if (open == null) continue;
      if (last?.kind === 'band' && last.stackId === open.stackId) continue;
      // The band's *own* first row, not whichever of its rows happened to be the
      // first one visible: every member is drawn from this offset, so anchoring
      // it to the visible row would slide the whole band down by however much of
      // it is above the fold and paint it over the grid below.
      const top = (display - at.offset) * this.rowHeight;
      sections.push({
        kind: 'band',
        key: `band-${open.stackId}`,
        top,
        stackId: open.stackId,
        position: open.position,
        photos: open.photos,
      });
    }
    return sections;
  }

  /**
   * The stack a selection of exactly one row stands for, if it is a stack.
   *
   * What "Unstack" is offered for: unstacking is about one stack, and a
   * selection spanning several says nothing about which. Only answerable for a
   * row this client is holding, which a single selected row always is - it is on
   * screen, because that is where it was clicked.
   */
  @computed get selectedStackId(): string | null {
    // Uncollapsed, a row is the photograph and not the stack it belongs to
    // (§19.5.4), so a selection of one says nothing about a stack to unmake.
    if (this.expandStacks) return null;
    if (this.selection.size !== 1 || this.selectedMembers.size > 0) return null;
    const only = this.selection.ranges[0];
    if (only == null) return null;
    return this.rows.get(only.start)?.stack_id ?? null;
  }

  expansionAt(position: number): Expansion | null {
    for (const open of this.expansions.values()) {
      if (open.position === position) return open;
    }
    return null;
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

  @computed get railHeight(): number {
    return railHeight(this.contentHeight);
  }

  /** How far the rail's origin can travel; 0 for a collection the rail covers whole. */
  @computed get anchorLimit(): number {
    return anchorLimit(this.contentHeight);
  }

  @computed get anchorTop(): number {
    return Math.min(this.anchorLimit, Math.max(0, this.railAnchor));
  }

  /** Where the viewport is in the collection, in content pixels. */
  @computed get virtualTop(): number {
    return this.anchorTop + this.railTop;
  }

  /** A position in content pixels, as a position inside the rail. */
  railPositionOf(contentTop: number): number {
    return contentTop - this.anchorTop;
  }

  /** Masonry only: the blocks whose tiles are mounted. Struct, as `visibleSpan` is. */
  @computed.struct get visibleBlocks(): Span {
    return visibleBlocks(this.blockTops, this.virtualTop, this.viewportHeight);
  }

  /** The photos the grid actually renders, as a half-open span of indices. */
  @computed get visible(): Span {
    if (this.total === 0) return { from: 0, to: 0 };
    if (this.mode === 'masonry') {
      const blocks = this.visibleBlocks;
      return { from: blocks.from * BLOCK, to: Math.min(this.total, blocks.to * BLOCK) };
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

  /** How far through the collection the viewport has got, 0 to 1. */
  @computed get scrollProgress(): number {
    const travel = this.contentHeight - this.viewportHeight;
    if (travel <= 0) return 0;
    return Math.min(1, Math.max(0, this.virtualTop / travel));
  }

  /** How much of the collection is on screen, 0 to 1, which is how long the thumb is. */
  @computed get viewportFraction(): number {
    if (this.contentHeight <= 0) return 1;
    return Math.min(1, this.viewportHeight / this.contentHeight);
  }

  // Where the viewport has to start, in content pixels, for the keyboard cursor
  // to be on screen - or null when it already is. Answered here rather than by
  // asking the focused tile to scroll itself into view: key repeat outruns
  // rendering, so the cursor lands several rows outside the window it was moved
  // from, and a tile that was never mounted cannot scroll anything - the cull
  // simply lost sight of the cursor.
  @computed get focusContentTop(): number | null {
    if (this.focusIndex < 0 || this.total === 0) return null;
    if (this.mode === 'masonry') {
      // No row arithmetic to land on, so this goes as far as the block: within
      // one, the tile is mounted and near enough.
      const block = Math.floor(this.focusIndex / BLOCK);
      const { from, to } = this.visibleBlocks;
      return block >= from && block < to ? null : Math.max(0, this.blockTops[block] ?? 0);
    }
    // Through the bands, because the scroll is in display rows: with one open
    // above the cursor, the row the photo is drawn on is further down than its
    // row in the collection, and scrolling to the latter lands a whole band's
    // height short of the tile every time.
    const row = displayRowOf(Math.floor(this.focusIndex / this.columns), this.bands, this.columns);
    const top = row * this.rowHeight;
    // The cell, not the row pitch: the gap under it is not part of the tile, and
    // scrolling to clear it would overshoot by one gap every time.
    const bottom = top + this.rowHeight - GRID_GAP;
    if (top < this.virtualTop) return Math.max(0, top);
    if (bottom > this.virtualTop + this.viewportHeight) return Math.max(0, bottom - this.viewportHeight);
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

  /** The open photo's place in the run, which is **not** a position in the collection. */
  @computed private get neighbourIndex(): number {
    const id = this.open?.id;
    return id == null ? -1 : this.neighbourhood.findIndex((photo) => photo.id === id);
  }

  // Off the run rather than off `rows`, and with no fallback to it. `rows` is the
  // collapsed listing, so a stack is one row there: stepping through it skipped
  // every frame a stack did not stand for, and a member opened from a band had no
  // row at all, which left both arrows dead (§19.5.3).
  @computed get prevPhotoId(): string | null {
    const i = this.neighbourIndex;
    return i > 0 ? (this.neighbourhood[i - 1]?.id ?? null) : null;
  }

  @computed get nextPhotoId(): string | null {
    const i = this.neighbourIndex;
    return i < 0 ? null : (this.neighbourhood[i + 1]?.id ?? null);
  }

  /**
   * Which photo the run has to be re-centred on, or null while the one in hand
   * still answers.
   *
   * A margin short of either end rather than at it, so a held arrow key never
   * catches up with the wire.
   */
  @computed get neighbourAnchor(): string | null {
    const id = this.open?.id;
    if (id == null || this.source == null) return null;
    const i = this.neighbourIndex;
    if (i < 0) return id;
    return i < NEIGHBOUR_MARGIN || i >= this.neighbourhood.length - NEIGHBOUR_MARGIN ? id : null;
  }
}

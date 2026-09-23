import { computed, observable } from 'mobx';
import { type EditDoc } from '../../../../../src/schemas/photo_edits';
import { type PhotoDetail, type PhotoSummary, type Triage } from '../../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { PathSegment, route } from '../../../../../src/schemas/route';
import { type Rendition } from '../../../../../src/services/processing/renditions/renditions';
import { renditionsApi } from '../../../api/renditions';
import type { Span } from '../../../ui/virtual_rows';
import { AlbumPhotosStrings } from '../../albums/album_photos_page.strings';
import { NoShootPhotosStrings } from '../../shoots/no_shoot_photos_page.strings';
import { ShootPhotosStrings } from '../../shoots/shoot_photos_page.strings';
import { collectionPath, isComposite, renditionVersion } from '../photos_store';
import { ViewerStoreStrings } from './viewer_store.strings';
import { BLOCK } from '../grid/grid_layout';
import { BinPageStrings } from '../grid/bin_page.strings';
import type { ListingStore } from '../grid/listing_store';
import type { StacksStore } from '../grid/stacks_store';
import type { Tonemap } from '../../raw_edit/print/print_scene';

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

/** How close to an end of the run the reader may get before it is re-centred. */
const NEIGHBOUR_MARGIN = 10;

export class ViewerStore {
  constructor(
    private readonly listing: ListingStore,
    private readonly stacks: StacksStore,
  ) {}

  // The rendition picked for this photo, for as long as it is open: the same
  // picture at one of three quality levels, each built on request and cached
  // (§10.2). Null until something is picked, which is the usual state - the
  // setting answers for the rest, and `showing` is what is actually on screen.
  @observable accessor rendition: ViewerRendition | null = null;
  // Which rendition an HDR frame is proofed against, kept across photos as a way of looking is.
  // Null follows the frame, which is also the only answer a frame with no HDR in it has.
  @observable accessor proof: 'hdr' | 'srgb' | null = null;
  @observable accessor proofTone: Tonemap = 'neutral';

  /** Whether the frame on screen for this photograph carries HDR, which is what an HDR proof needs. */
  showsHdr(photoId: string): boolean {
    const { rendition } = this.frameOf(photoId);
    return rendition !== 'embedded' && this.detailFor(photoId)?.renditions?.[rendition]?.hdr === true;
  }

  proofOf(photoId: string): 'hdr' | 'srgb' {
    return this.showsHdr(photoId) ? this.proof ?? 'hdr' : 'srgb';
  }
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
  // Every photograph whose detail this session has read, oldest first. A cull flips between
  // two frames far more often than it walks forward, and a read per step made the gesture it
  // is built around the slowest one - so a step back to a photograph already opened is
  // answered from here. Everything that rewrites a detail writes into it in place
  // (`renditionsRebuilt`, the patch behind a star), so a hit is not a stale answer.
  //
  // Deep, not by reference: five panels read different parts of one entry, and a replaced
  // object notifies all of them. Rating a photo would re-render the camera settings and the
  // file paths beside it, for the same reason the grid keeps its row objects rather than
  // remapping them (`reconcile`).
  @observable accessor details = new Map<string, PhotoDetail>();
  // The photograph the last detail arrived for, which is the *previous* one until the open
  // photo's read lands - deliberately, so the sidebar and the title do not collapse on every
  // step. Nothing else should read a detail without saying which photo it wants, which is
  // what `detailFor` is for.
  @observable accessor lastDetailId: string | null = null;
  @observable accessor notesSavedAt: number | null = null;
  // The verdict the viewer's control keeps lit for a beat after a judgement, while the stage
  // has already stepped to the next photograph. Null the rest of the time, when the control
  // shows the open photo's own verdict.
  @observable accessor heldVerdict: Triage | null = null;
  // The develop documents behind them, kept and dropped the same way.
  @observable accessor editDocs = new Map<string, EditDoc>();
  @observable accessor orientationVersions = new Map<string, number>();
  // Every frame the viewer has decoded for the photo it is on, measured off the
  // image rather than taken from a column, which is the question a reader judging
  // sharpness is asking. In the order they first arrived, which is also the order
  // the stage mounts them in.
  //
  // All of them rather than the last one: the renditions a photo has shown stay
  // mounted, so going back to one is an opacity change with no decode - and with
  // nothing decoding there is nothing to report a size, so a last-one-wins slot
  // leaves the panel reading "loading" for as long as the reader stays on the
  // frame they have returned to.
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
  // How many times the reader has picked a rendition by hand.
  @observable accessor renditionPicks = 0;
  // The box the detail view's stage, panels and filmstrip share, written by the
  // presenter from a ResizeObserver. Which edge the panels and the strip take are
  // questions about this box (`viewer_edges.ts`), and it is never read back out of
  // the DOM.
  @observable accessor detailWidth = 0;
  @observable accessor detailHeight = 0;
  // What the viewer's filmstrip has on screen, or null when none is mounted. The
  // strip scrolls the same collection on its own rail, so the rows it is over are
  // rows this client has to hold (`neededBlocks`).
  @observable.ref accessor stripSpan: Span | null = null;

  // As much of a photo as the client has: the grid row, or the detail when there
  // is no row (a deep link, or a photo scrolled far enough past to be dropped).
  // Enough for a verdict, a rating and the shape the viewer lays itself out
  // against, all of which the row already carries - so none of them wait on the
  // fetch.
  photoFor(photoId: string): PhotoSummary | null {
    // The run last, after the detail: a patched detail is re-read on every write,
    // where a run row is only replaced when the run is re-fetched, so putting it
    // first would show a verdict reverting on the photograph it was just set on.
    return this.listing.rowById(photoId) ?? this.stacks.memberById(photoId) ?? this.detailFor(photoId) ?? this.neighbourById(photoId);
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

  // For a photo the view knows only by id - the neighbours the viewer warms.
  // Anything holding the row itself reads `renditionVersion` off it directly,
  // which is both cheaper and narrower to observe.
  renditionVersionOf(photoId: string | null, rendition: Rendition | ViewerRendition): number {
    if (photoId == null) return 0;
    return renditionVersion(this.photoFor(photoId), rendition);
  }

  // The shell reads this rather than detail?.library_id. As a computed it only
  // notifies when the *library* changes, so stepping through photos in one
  // library never re-renders the sidebar or the title bar.
  @computed get detailLibraryId(): string | null {
    return this.details.get(this.lastDetailId ?? '')?.library_id ?? null;
  }

  // Where leaving the viewer goes, and what to call it: the collection the photo
  // was opened from, so a shoot or an album returns to itself rather than to the
  // whole library. Struct, so stepping between photos of one collection does not
  // re-render the bar the button sits in.
  @computed.struct get openedFrom(): { path: string; label: string } {
    const source = this.listing.source;
    if (source == null) {
      // A deep link, for the moment before the library it loads behind itself
      // becomes the collection.
      return {
        path: this.detailLibraryId == null ? route() : route(PathSegment.libraries(), this.detailLibraryId),
        label: ViewerStoreStrings.backToLibrary(),
      };
    }
    const label =
      source.kind === 'shoot' ? ShootPhotosStrings.shoot()
      : source.kind === 'album' ? AlbumPhotosStrings.album()
      : source.kind === 'bin' ? BinPageStrings.bin()
      : source.kind === 'no_shoot' ? NoShootPhotosStrings.notInAnyShoot()
      : ViewerStoreStrings.backToLibrary();
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

  /**
   * The stored rendition "Rebuild rendition" would remake, or null where there is none.
   *
   * Whichever is on screen, that being the one the reader is judging - and the render
   * behind it where that is the camera's JPEG, which is the RAW's own bytes and has no
   * build to force past. Null unless a file is actually there to remake: this is the one
   * action that rewrites something rather than making it, so it is offered against what the
   * detail statted rather than against what a library setting suggests should exist.
   */
  @computed get rerenderTarget(): ViewerRendition | null {
    // Whether the camera view on screen is something this row *builds* is its recipe's answer:
    // a row that composites one remakes it as itself, and one that hands over bytes from inside
    // its own file has no build to force past, so what there is to remake is the render behind
    // it (`renditions.ts`).
    const target = this.showing === 'embedded' && !isComposite(this.openPhoto) ? 'full' : this.showing;
    return this.detailFor(this.open?.id ?? '')?.renditions?.[target]?.built === true ? target : null;
  }

  /**
   * The frame this photograph is drawn from: the file, and which rendition it is.
   *
   * **One question, asked of any id.** The picture the viewer opened on and the neighbours
   * it holds ready either side go through this same call, so a neighbour is mounted at
   * exactly what it will be shown at and stepping onto it reveals the raster already there.
   * Two paths here meant holding one file and then showing another.
   *
   * Both halves together, because they have to agree: the rendition is what a 404 on this
   * URL asks the server to build, and derived a second time beside the call it can name a
   * different one - `open` lags the route by a render, so the photograph just stepped away
   * from is a neighbour and the open photo at once.
   */
  frameOf(photoId: string): { source: string; rendition: ViewerRendition } {
    const rendition = this.overrideFor(photoId) ?? this.shownRenditionOf(photoId);
    return { source: this.sourceOf(photoId, rendition), rendition };
  }

  /**
   * The file one rendition of a photograph is served from, versioned by the stamp that
   * moves when that file is rebuilt (§13.5).
   */
  sourceOf(photoId: string, rendition: ViewerRendition): string {
    const url = renditionsApi.url(photoId, rendition, this.renditionVersionOf(photoId, rendition));
    const orientationVersion =
      rendition === 'embedded' && this.servedWhole(photoId, rendition) ? this.orientationVersions.get(photoId) : null;
    return orientationVersion == null ? url : url + (url.includes('?') ? '&' : '?') + 'orientation=' + orientationVersion;
  }

  /**
   * Whether this row is served this rendition **whole** - handed over from inside a file it
   * already has - rather than built (`renditions::owedOf`).
   *
   * True of one thing: the cameras' own picture of a row that names one file, which is bytes
   * inside that file. A row composed out of others has none to lift, so it composites its
   * frames' into one and files it like any other copy, and everything about asking for it is
   * the same as asking for a render.
   *
   * The whole of what the two arms do not share, and both readers of it are about *cost*: a
   * copy that is handed over is there whenever its file is, so there is no build to wait for
   * and no build to ask for when one 404s.
   */
  servedWhole(photoId: string, rendition: ViewerRendition): boolean {
    return rendition === 'embedded' && !isComposite(this.photoFor(photoId));
  }

  /**
   * The rendition the reader picked with `i`/`o`/`m`, or null where they have picked none.
   *
   * **Per photograph.** One slot holds it, cleared on the step (`beginDetail`), so it is
   * only ever the open photograph's - and `open` lags the route by a render, so asking
   * without naming the photo hands the picture just stepped to a choice made about the one
   * before it: a frame mounted at a rendition nobody asked it for, and a 404 that the guard
   * meant to protect a deliberate pick then swallows.
   */
  overrideFor(photoId: string): ViewerRendition | null {
    return photoId === this.open?.id ? this.rendition : null;
  }

  /**
   * Which rendition the server resolved for this photograph.
   *
   * The detail's answer before the row's, both being the server's: a listing row cannot say
   * whether `max` is built, so its answer is the approximation to open on and the detail's
   * is the one to keep. Taken the other way round - `photoFor` reaches the row first - a
   * photograph opened from the grid was drawn from whatever its page was listed under, and
   * a choice made since, or an edit made since, was silently discarded.
   */
  shownRenditionOf(photoId: string): ViewerRendition {
    return this.detailFor(photoId)?.shown_rendition ?? this.photoFor(photoId)?.shown_rendition ?? 'embedded';
  }

  /** The rendition on screen: the reader's choice for this photo, or what the server resolved. */
  @computed get showing(): ViewerRendition {
    const open = this.open?.id ?? '';
    return this.overrideFor(open) ?? this.shownRenditionOf(open);
  }

  /**
   * Changes whenever a frame that failed is worth asking for again.
   *
   * A failure is remembered per source and the URL only moves when the file behind it is
   * rebuilt, so nothing asks a second time on its own - and the stage drops a failed frame
   * from what it mounts, which leaves the rendition beside it on screen and the picker
   * looking like a control that does nothing. Pressing the key again is the reader saying
   * to try, and it is the only gesture they have; without it here, one unreadable frame
   * takes that rendition away for the life of the page.
   */
  @computed get retryEpoch(): number {
    return this.serverEpoch + this.renditionPicks;
  }

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

  // This photo's detail, or null until one has been read for it. Asked by photo rather than
  // read off a single slot, because the view holds one id and the last read answered for
  // another: the two disagree for the length of a fetch, and every consumer needs the check.
  detailFor(photoId: string): PhotoDetail | null {
    return this.details.get(photoId) ?? null;
  }

  /** This photo's develop document, or null until one has been read for it. */
  editsFor(photoId: string): EditDoc | null {
    return this.editDocs.get(photoId) ?? null;
  }

  /** Which way the reader arrived at this photo, or null if they did not step to it. */
  stepTo(photoId: string): 'next' | 'prev' | null {
    const step = this.lastStep;
    return step?.to === photoId ? step.direction : null;
  }

  // Which blocks have to be in memory. What is on screen - in the gallery, or in
  // the viewer's filmstrip, which scrolls the same collection - plus the block
  // either side of the photo the viewer is on, so stepping past the end of the
  // window is a fetch rather than a dead arrow.
  //
  // This is what *keeps* a block as much as what fetches one, so a view whose span
  // is missing from it has its rows evicted as fast as they arrive.
  //
  // Block 0 whenever nothing is loaded, because the collection's size is itself
  // something only a request can answer.
  @computed get neededBlocks(): number[] {
    if (this.listing.total === 0) return [0];
    const blocks = new Set<number>();
    for (const { from, to } of [this.listing.visible, ...(this.stripSpan == null ? [] : [this.stripSpan])]) {
      for (let index = from; index < to; index += BLOCK) blocks.add(Math.floor(index / BLOCK));
      if (to > from) blocks.add(Math.floor((to - 1) / BLOCK));
    }
    const open = this.detailIndex;
    if (open >= 0) for (const index of [open - 1, open, open + 1]) blocks.add(Math.floor(Math.max(0, index) / BLOCK));
    return [...blocks].filter((block) => block >= 0 && block < this.listing.blockCount).sort((a, b) => a - b);
  }

  // --- the open photo's neighbours ---

  // Position of the open photo in the collection, so the detail view can step to
  // its neighbours. Off the photo that was asked for, not the detail on hand:
  // that is still the previous photo until the fetch lands, and stepping faster
  // than it does made the arrow keys offer the neighbours of the frame before -
  // so a press navigated to the photo already open and did nothing.
  @computed get detailIndex(): number {
    const id = this.open?.id;
    return id == null ? -1 : this.listing.indexOf(id);
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
   * The run spanning these photographs, `reach` either side, in the collection's order.
   * Empty where the run holds none of them.
   *
   * **Several, because a window around one photograph slides.** The viewer's stage holds
   * every photograph named here, and each step then reveals one at the leading edge and
   * drops one at the trailing edge - so a reader going back and forth between two frames
   * remounts the same third picture on every press, which is a request and a decode for a
   * file the page was holding a moment ago. Widening the window does not help: it moves
   * which photograph churns and nothing else. Spanning the one they are on *and* the one
   * they came from does, the two windows overlapping into a run that is the same set
   * whichever of the pair they are standing on.
   */
  runCovering(photoIds: readonly (string | null)[], reach: number): string[] {
    const at = photoIds.map((id) => this.neighbourhood.findIndex((photo) => photo.id === id)).filter((i) => i >= 0);
    if (at.length === 0) return [];
    return this.neighbourhood
      .slice(Math.max(0, Math.min(...at) - reach), Math.max(...at) + reach + 1)
      .map((photo) => photo.id);
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
    if (id == null || this.listing.source == null) return null;
    const i = this.neighbourIndex;
    if (i < 0) return id;
    return i < NEIGHBOUR_MARGIN || i >= this.neighbourhood.length - NEIGHBOUR_MARGIN ? id : null;
  }
}

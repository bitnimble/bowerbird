import { action, runInAction } from 'mobx';
import { type Ordering } from '../../../../../src/schemas/common';
import { type CompositeKind, type PhotoSelection, type PhotoSummary, type PhotoTarget } from '../../../../../src/schemas/photos';
import type { RequestActivity } from '../../../../../src/schemas/request_activity';
import { compositesApi } from '../../../api/composites';
import { photosApi } from '../../../api/photos';
import { stacksApi } from '../../../api/stacks';
import type { CompositePhoto, CompositeProgress } from '../../../../../src/schemas/composition';
import type { ToastsPresenter } from '../../toasts/toasts_presenter';
import { displayRowOf, rowAt, type Expansion } from './bands';
import type { ScrollRailPresenter } from './scroll_rail_presenter';
import type { PhotoSource } from '../photos_store';
import { PhotosPresenterStrings } from '../photos_presenter.strings';
import type { SelectionPresenter } from './selection_presenter';
import type { ListingStore } from './listing_store';
import type { MarksStore } from './marks_store';
import type { StacksStore } from './stacks_store';

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

export class StackActionsPresenter {
  // Stacks whose members are on the wire, so a second click on the same badge
  // cannot open one band and correct the scroll for two.
  private readonly opening = new Set<string>();
  // The band opened for the viewer rather than by the reader (`followBand`), and
  // so the only one it may close again.
  private autoBand: string | null = null;
  // The toast a merge is reporting into, so its bar is moved rather than a second one raised at
  // every step.
  private mergeToast: number | null = null;

  constructor(
    private readonly listing: ListingStore,
    private readonly marks: MarksStore,
    private readonly store: StacksStore,
    private readonly rail: ScrollRailPresenter,
    private readonly selection: SelectionPresenter,
    private readonly toasts: ToastsPresenter,
    private readonly generation: () => number,
    private readonly selectionFilters: (expandStacks?: boolean) => PhotoSelection['filters'],
    private readonly selectionTarget: () => PhotoTarget | null,
    private readonly clearSelectedPositions: () => void,
    private readonly dropConsumedSelection: () => void,
    private readonly refresh: () => Promise<void>,
    private readonly fail: (error: unknown) => void,
  ) {}

  @action.bound
  rememberStack(stackId: string, photos: PhotoSummary[]): void {
    const next = new Map(this.store.stackMembers);
    next.set(stackId, photos);
    this.store.stackMembers = next;
  }

  @action.bound
  clearStackMembers(): void {
    this.store.stackMembers = new Map();
  }

  @action.bound
  clearExpansions(): void {
    this.store.expansions = new Map();
  }

  @action.bound
  resetCollection(): void {
    this.store.expansions = new Map();
    this.store.stackTileBoxes = new Map();
  }

  @action.bound
  measuredStackTile(stackId: string, x: number, width: number, height: number): void {
    const held = this.store.stackTileBoxes.get(stackId);
    const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;
    if (held != null && same(held.x, x) && same(held.width, width) && same(held.height, height)) return;
    const next = new Map(this.store.stackTileBoxes);
    next.set(stackId, { x, width, height });
    this.store.stackTileBoxes = next;
  }

  @action.bound
  patchPhoto(photoId: string, fields: Partial<PhotoSummary>): void {
    const photo = this.store.memberById(photoId);
    if (photo != null) Object.assign(photo, fields);
  }

  // A measurement outlives the band it was taken for otherwise, and a stack the
  // reader keeps opening and closing would leave one behind every time.
  @action
  private forgetStackTiles(open: ReadonlyMap<string, Expansion>): void {
    if (this.store.stackTileBoxes.size === 0) return;
    this.store.stackTileBoxes = new Map([...this.store.stackTileBoxes].filter(([stackId]) => open.has(stackId)));
  }

  // --- stacks (§19.6) ---

  /**
   * Opens or closes the band of rows a tile stands for: a stack's members, or the frames a
   * composite was made from.
   *
   * **Keyed by whichever row the band belongs to**, which is a stack id for one and a photograph's
   * id for the other. The two are the same gesture and the same band; what differs is only where
   * the rows come from, so `frames` is the whole of the difference.
   *
   * Opening one above the viewport displaces everything below it, so the view is
   * moved by exactly the height the band inserted and nothing appears to move.
   * Every input is a number the store already holds, which is what lets this be
   * arithmetic rather than a measurement.
   */
  @action.bound
  async toggleBand(stackId: string, position: number, frames: CompositeKind | null = null): Promise<void> {
    if (this.store.expansions.has(stackId)) {
      this.closeBand(stackId);
      return;
    }
    // A second click while the members are still in flight would otherwise open
    // the band once and correct the scroll twice, because both calls see it
    // closed. The reader asked for open-then-closed, so the second click is
    // dropped rather than queued: the band is about to be open either way.
    if (this.opening.has(stackId)) return;
    const scope = this.bandScope();
    if (scope == null) return;
    this.opening.add(stackId);
    const source = this.listing.source;
    const generation = this.generation();
    try {
      const photos = frames != null ? await compositesApi.listFrames(stackId) : await stacksApi.listPhotos(stackId, scope);
      runInAction(() => {
        // The collection this was opened against may have been replaced while
        // the members were on the wire, and those positions describe a listing
        // that no longer exists.
        if (this.generation() !== generation || this.listing.source !== source) return;
        const was = this.anchoredPosition();
        const next = new Map(this.store.expansions);
        next.set(stackId, { stackId, composite: frames, position, photos, keepOpen: this.isLoneRow(position) });
        this.store.expansions = next;
        // Not `frames`: a panorama's frames are a different set from the stack's members, and what
        // a selected stack tile stands for is the members.
        if (frames == null) this.rememberStack(stackId, photos);
        this.holdRowThroughBands(was);
      });
    } catch (err) {
      this.fail(err);
    } finally {
      this.opening.delete(stackId);
    }
  }

  /** Closes a stack's band, if it has one open. */
  @action.bound
  closeBand(stackId: string): void {
    const open = this.store.expansions.get(stackId);
    if (open == null) return;
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
    this.selection.dropMembers(closed);
    this.holdRowThroughBands(was);
  }

  /**
   * Follows the viewer into and out of a stack: the band of the stack the open
   * photograph belongs to is held open while the reader is inside it, and closed
   * again when they step out.
   *
   * A collapsed listing gives a stack's members no row (§19.5.1), so without this
   * the filmstrip has no cell to mark and reads as though nothing is open at all.
   *
   * Only ever the band this opened: one the reader opened themselves is theirs,
   * and stepping past it must not close it.
   */
  async followBand(stackId: string | null): Promise<void> {
    if (stackId === this.autoBand) return;
    const held = this.autoBand;
    this.autoBand = null;
    if (held != null) this.closeBand(held);
    if (stackId == null || this.store.expansions.has(stackId)) return;
    this.autoBand = stackId;
    const position = await this.positionOfStack(stackId);
    // Stepped on again while either answer was on the wire, which `closeBand`
    // found nothing to close.
    if (this.autoBand !== stackId) return;
    if (position == null) {
      this.autoBand = null;
      return;
    }
    await this.toggleBand(stackId, position);
    if (this.autoBand !== stackId) this.closeBand(stackId);
  }

  // Where a stack's collapsed row sits. Off the loaded window where it is in it -
  // a stack stepped into from beside it always is - and off the server otherwise,
  // which is the case the viewer is opened straight onto a member in: a member has
  // no row of its own, so nothing has asked for the block its stack's row is in.
  private async positionOfStack(stackId: string): Promise<number | null> {
    for (const [position, row] of this.listing.rows) if (row.stack_id === stackId) return position;
    const source = this.listing.source;
    if (source == null) return null;
    try {
      const found = await photosApi.positions({
        scope: scopeOf(source),
        filters: this.selectionFilters(),
        keys: [stackId],
      });
      // One position, since a collapsed listing gives a stack exactly one row.
      return found[stackId]?.[0] ?? null;
    } catch {
      // A strip with no cell to mark, which is what it already had: nothing here
      // is worth a message over.
      return null;
    }
  }

  // Where the reader is, for handing to `rail.shift` after the collection's height
  // has changed under them. The row at the top of the viewport and where it was
  // drawn are what let a change to *several* bands at once be undone
  // (`replaceBands`), not just a change to one.
  private anchoredPosition(): { anchorTop: number; gridRow: number; displayRow: number } {
    const columns = this.listing.columns;
    const bands = this.listing.bands;
    const at = rowAt(Math.floor(this.listing.rail.at / this.listing.rowHeight), bands, columns);
    const gridRow = at.kind === 'grid' ? at.row : Math.floor(at.band.position / columns);
    return {
      anchorTop: this.listing.rail.anchor,
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
  private holdRowThroughBands(was: { anchorTop: number; gridRow: number; displayRow: number }): void {
    if (this.listing.mode === 'masonry') return;
    const moved = displayRowOf(was.gridRow, this.listing.bands, this.listing.columns) - was.displayRow;
    this.rail.shift(moved * this.listing.rowHeight, was.anchorTop);
  }

  /**
   * Re-places every open band, and closes the ones whose stack has left.
   *
   * A band is pinned to its stack, never to the position it was opened at, so a
   * re-order or an import moves where it is drawn rather than closing it. The
   * server is asked for every band in one call: numbering rows costs an ordered
   * pass over the collection, and ten open bands must not mean ten of them.
   */
  async replaceBands(activity: RequestActivity = 'interactive'): Promise<void> {
    const source = this.listing.source;
    const scope = this.bandScope();
    if (source == null || scope == null || this.store.expansions.size === 0) return;
    const keys = [...this.store.expansions.keys()];
    const generation = this.generation();
    try {
      const [positions, members] = await Promise.all([
        photosApi.positions({ scope: scopeOf(source), filters: this.selectionFilters(), keys }),
        // Re-read alongside the positions, because a refresh follows the actions
        // that change what a stack holds: without this, photos just removed from
        // a stack stay drawn in its band until it is closed and opened again.
        Promise.all(
          keys.map((key) =>
            (this.store.expansions.get(key)?.composite != null
              ? compositesApi.listFrames(key, undefined, activity)
              : stacksApi.listPhotos(key, scope, undefined, activity))
              .then((photos) => [key, photos] as const)
              .catch(() => [key, null] as const),
          ),
        ),
      ]);
      runInAction(() => {
        if (this.generation() !== generation || this.listing.source !== source) return;
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
          // One position, since a collapsed listing gives a stack exactly one row.
          const position = positions[stackId]?.[0];
          const photos = fresh.get(stackId);
          // Absent means the stack is no longer in this collection at all - a
          // filter that excludes every member, or an unstack - which is the one
          // thing that closes a band on its own. A stack down to one member is
          // an ordinary photograph again, so its band closes with it.
          if (position == null || photos == null || photos.length < 2) continue;
          // A row that has stopped standing for a stack has nothing to hang a band
          // off - unless the reader opened this one from exactly that tile.
          if (!open.keepOpen && this.isLoneRow(position)) continue;
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
        this.selection.retainMembers(live);
      });
    } catch (err) {
      this.fail(err);
    }
  }

  // Whether the row at a position stands for one photograph rather than a stack,
  // which is what the filter leaves behind when it hides all but one member.
  private isLoneRow(position: number): boolean {
    // `rows` is the loaded window, so an absent row is one this client is not
    // holding rather than one that has shrunk - and closing a band on that would
    // close every band the reader has scrolled away from.
    return (this.listing.rows.get(position)?.stack_size ?? 2) < 2;
  }

  // What a band has to answer for: the album it is being shown in, the shoot it is being shown in,
  // which side of the bin the listing is on, and the sort the members are drawn in - which is the
  // collection's, so the band reads in the order the viewer steps through it.
  //
  // Every one of these is the band agreeing with the listing it was opened from, which is what keeps
  // a tile's count and the rows behind it the same number: the album narrows the members to what it
  // holds, the shoot exempts its own hiding (§12.4), and the bin picks which side of it to answer
  // for.
  //
  // Null until the collection's first page has stated its sort, which is before
  // there is a row to open a band from.
  bandScope(): { ordering: Ordering; albumId?: string; shootId?: string; deleted?: boolean } | null {
    const source = this.listing.source;
    const ordering = this.listing.ordering;
    if (ordering == null) return null;
    return {
      ordering,
      albumId: source?.kind === 'album' ? source.albumId : undefined,
      shootId: source?.kind === 'shoot' ? source.shootId : undefined,
      deleted: source?.kind === 'bin' ? true : undefined,
    };
  }


  /** Makes a stack of whatever is selected. */
  async stackSelection(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    const taken = [...this.store.expansions.values()].filter(
      (open) => open.composite == null && open.photos.every((photo) => this.marks.memberSelected(photo)),
    );
    try {
      const stack = await stacksApi.create(target);
      this.carryBandsTo(stack.id, taken);
      this.clearSelectedPositions();
      await this.refresh();
      this.dropConsumedSelection();
    } catch (err) {
      this.fail(err);
    }
  }

  // An open stack wholly taken into a new one stays open as it. The new stack has
  // an id of its own, so left under the old one the re-read closes the band.
  @action
  private carryBandsTo(stackId: string, taken: Expansion[]): void {
    const still = taken.filter((open) => this.store.expansions.get(open.stackId) === open);
    const [first] = still;
    if (first == null) return;
    const was = this.anchoredPosition();
    const next = new Map(this.store.expansions);
    for (const open of still) next.delete(open.stackId);
    next.set(stackId, { ...first, stackId, photos: still.flatMap((open) => open.photos) });
    this.store.expansions = next;
    this.holdRowThroughBands(was);
  }

  async mergeSelectionToPanorama(): Promise<void> {
    await this.mergeSelection(compositesApi.createPanorama);
  }

  /** Merges a selected bracket stack into the photograph its capture was shot for. */
  async mergeSelectedBracket(): Promise<void> {
    await this.mergeSelection(compositesApi.mergeBracket);
  }

  /**
   * Merges whatever is selected into one photograph.
   *
   * The same target the stack action takes, and the same refresh afterwards: what
   * comes back is a stack, drawn from the composite rather than from a member.
   * The call is as long as the alignment and the first two renditions, so the
   * selection stays put until it answers - a cleared selection with nothing new in
   * the grid reads as an action that did nothing.
   */
  private async mergeSelection(merge: (target: PhotoTarget) => Promise<CompositePhoto>): Promise<void> {
    const target = this.selectionTarget();
    // One at a time: the merge holds the device for minutes, and the selection is still on screen
    // while it runs, so the entry stays clickable.
    if (target == null || this.store.mergingRows != null) return;
    const source = this.listing.source;
    const generation = this.generation();
    this.startedMerging();
    try {
      await merge(target);
      // Minutes, in which the reader may have moved to another collection and selected in it:
      // what came back describes the listing the merge was asked from, and clearing a selection
      // that has nothing to do with it is the one thing worse than not clearing this one.
      if (this.generation() !== generation || this.listing.source !== source) return;
      this.clearSelectedPositions();
      await this.refresh();
      this.dropConsumedSelection();
    } catch (err) {
      this.fail(err);
    } finally {
      this.stoppedMerging();
    }
  }

  /** Starts analysing these frames into an assembly, answering the job, or null where it was refused. */
  async startAssembly(frameIds: string[]): Promise<string | null> {
    try {
      const { jobId } = await compositesApi.startAssembly(frameIds);
      return jobId;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  /**
   * How far the merge has got, as the server measures it.
   *
   * The rows are already dimmed by then - this client dimmed its own selection as it asked - and
   * what arrives here is the phase, the share behind it, and the ids, which is how a second view
   * of the same library dims them too.
   */
  @action.bound
  compositeProgressed(progress: CompositeProgress): void {
    if (progress.phase === 'done' || progress.phase === 'failed') {
      this.stoppedMerging();
      return;
    }
    const rows = this.store.mergingRows;
    // Named once, at the start of the merge, and the same set every event after: replaced only
    // when they are new, so a tile is not re-rendered by a bar it does not draw.
    if (rows == null || rows.photoIds.size !== progress.photoIds.length) {
      this.store.mergingRows = { positions: rows?.positions ?? new Set(), photoIds: new Set(progress.photoIds) };
    }
    if (this.mergeToast == null) {
      this.mergeToast = this.toasts.showProgress(PhotosPresenterStrings.merging(progress.phase), progress.fraction);
      return;
    }
    this.toasts.progressed(
      this.mergeToast,
      PhotosPresenterStrings.merging(progress.phase),
      progress.fraction,
    );
  }

  // The rows this client asked to merge, dimmed from the click rather than from the first event:
  // the align's own first step is a decode, so the stream has nothing to say for a second or two.
  @action.bound
  private startedMerging(): void {
    const positions = new Set<number>();
    for (const range of this.marks.selection.ranges) {
      for (let at = range.start; at <= range.end; at++) positions.add(at);
    }
    this.store.mergingRows = { positions, photoIds: new Set(this.marks.selectedMembers) };
    this.mergeToast ??= this.toasts.showProgress(PhotosPresenterStrings.merging('aligning'), 0);
  }

  @action.bound
  private stoppedMerging(): void {
    this.store.mergingRows = null;
    if (this.mergeToast == null) return;
    this.toasts.dismiss(this.mergeToast);
    this.mergeToast = null;
  }

  /**
   * Takes apart every stack the selection touches.
   *
   * The server resolves which those are, from the photographs the selection
   * names: a selection reaching rows this client never held names stacks it
   * cannot see, and a run over a collapsed listing names a stack's row without
   * ever being told its id (§18.3.3).
   *
   * The bands close themselves: the re-read below is what notices a stack has
   * gone from the collection, and it does it holding the row the reader was on
   * (`replaceBands`). Emptying them here instead took the bands of stacks that
   * were never touched with it, and jumped the scroll by their height.
   */
  async unstackSelection(): Promise<void> {
    const target = this.selectionTarget();
    if (target == null) return;
    try {
      await stacksApi.unstack(target);
      this.clearSelectedPositions();
      await this.refresh();
      this.dropConsumedSelection();
    } catch (err) {
      this.fail(err);
    }
  }

  /** Takes the selected band members out of the stacks they are in. */
  async removeSelectedFromStacks(): Promise<void> {
    const byStack = new Map<string, string[]>();
    for (const open of this.store.expansions.values()) {
      const chosen = open.photos.filter((photo) => this.marks.selectedMembers.has(photo.id)).map((photo) => photo.id);
      if (chosen.length > 0) byStack.set(open.stackId, chosen);
    }
    if (byStack.size === 0) return;
    try {
      for (const [stackId, photoIds] of byStack) await stacksApi.removePhotos(stackId, photoIds);
      this.selection.clearMemberSelection();
      await this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

}

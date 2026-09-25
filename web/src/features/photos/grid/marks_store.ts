import { computed, observable } from 'mobx';
import { type PhotoSummary, type Triage } from '../../../../../src/schemas/photos';
import { isComposite, MERGE_MAX_FRAMES, type MergeCandidate, type StackSelection } from '../photos_store';
import { SelectionRanges } from '../selection';
import { displayRowOf, type Expansion } from './bands';
import { GRID_GAP } from './grid_layout';
import type { ListingStore } from './listing_store';
import type { StacksStore } from './stacks_store';

export class MarksStore {
  constructor(
    private readonly listing: ListingStore,
    private readonly stacks: StacksStore,
  ) {}

  // Whether a tile wears its verdict and its rating. Both on, because a cull is
  // made of the two and a tile that shows neither cannot be judged from - and both
  // optional, because a reader who has finished judging is looking at photographs
  // and every mark is something drawn over one.
  @observable accessor showTriage = true;
  @observable accessor showRating = true;
  // Which positions are selected, as runs (§18.3.3). Held by reference: it is an
  // immutable value, so one selection change is one notification. Every mounted
  // tile re-renders on it, which is affordable now that what is mounted is
  // bounded by the viewport rather than by the collection.
  @observable.ref accessor selection: SelectionRanges = SelectionRanges.EMPTY;
  /**
   * Anchor for shift-click range selection: the position last picked on its own,
   * and whether that pick chose it or unchose it.
   *
   * The verb travels with the anchor because a span drawn back from a photo just
   * unpicked *unpicks*, which is how a few frames are taken out of a long run
   * without dropping it and starting again.
   */
  @observable.ref accessor lastToggled: { position: number; selected: boolean } | null = null;
  // The same anchor inside an open band, which spans members rather than
  // positions: a band's photographs have no position in a collapsed listing.
  @observable.ref accessor lastToggledMember: { id: string; selected: boolean } | null = null;
  // Which members of open bands are selected, by id.
  //
  // Ids rather than positions, and legitimately so: the listing is collapsed, so
  // the server numbers one row per stack and a member has no position at all. The
  // rule the virtual grid enforces is that an id must never stand in for an
  // *unloaded* position, and a band's members are loaded, on screen, and few.
  @observable accessor selectedMembers = new Set<string>();
  // Which tile the keyboard is on. -1 means the grid has not been entered yet.
  @observable accessor focusIndex = -1;
  // Whether the cursor is drawn. A click moves it too - the cull keys have to act
  // on what was last touched, whichever hand touched it - but a ring left behind
  // by a click is a mark on a photograph nobody is about to do anything to, and it
  // outlives the gesture that made it (§18.3.1).
  @observable accessor showsCursor = false;

  /**
   * Whether a band's row is selected *as the stack*, which is what the server
   * resolves it to (§19.6.1).
   *
   * Uncollapsed the row is the photograph it shows and stands for nothing else
   * (§19.5.4), which is what `stack_size` reports there.
   */
  bandRowSelected(open: Expansion): boolean {
    return this.selection.has(open.position) && (this.listing.rows.get(open.position)?.stack_size ?? 0) > 1;
  }

  /**
   * Whether a band member is selected - by its own pick, or by the row above it
   * standing for the whole stack. Both, because a span drawn over an open stack
   * acts on every member of it, and a band that drew none of them chosen would
   * be saying the opposite.
   */
  memberSelected(photo: PhotoSummary): boolean {
    if (this.selectedMembers.has(photo.id)) return true;
    const open = this.stacks.bandOf(photo);
    return open != null && this.bandRowSelected(open);
  }

  // Positions and members together: they are one selection, and an action reaches
  // both (§19.6.1). Entries, so a stack counts once here whatever it holds -
  // which is the question the gestures ask, and the one "Stack" needs two of.
  /**
   * Rows and band members picked, a collapsed stack counting as the one row it is.
   *
   * What [`selectionCount`] is to this is what [`selectedLoadedPhotos`] is to
   * [`selectedLoadedRows`]: the same selection said in photographs rather than in rows.
   */
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
    for (const [index, row] of this.listing.rows) {
      if (row.stack_size > 1 && this.selection.has(index)) count += row.stack_size - 1;
    }
    for (const open of this.stacks.expansions.values()) {
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
    return this.listing.total > 0 && this.selection.size === this.listing.total && this.selectedMembers.size === 0;
  }

  // Count first, so a populated grid's dependency on `loading` short-circuits
  // away: it toggles on every block a scroll asks for, and the answer cannot
  // change.
  @computed get isEmpty(): boolean {
    return this.listing.total === 0 && !this.listing.loading;
  }

  @computed get focusedPhoto(): PhotoSummary | null {
    return this.listing.rows.get(this.focusIndex) ?? null;
  }

  @computed get isBin(): boolean {
    return this.listing.source?.kind === 'bin';
  }

  /**
   * The selected rows and band members this client is actually holding, as rows:
   * a collapsed stack is **one** of these, the row that stands for it.
   *
   * A **sample**, not the answer: a selection reaches rows that were never
   * loaded or have since been evicted, so absence from here means "not seen"
   * rather than "not selected". Only good for a guard that must not block what
   * it cannot see, or for a control whose state the server settles - the server
   * is what refuses, and what acts.
   */
  @computed get selectedLoadedRows(): PhotoSummary[] {
    const photos: PhotoSummary[] = [];
    for (const [index, row] of this.listing.rows) if (this.selection.has(index)) photos.push(row);
    for (const open of this.stacks.expansions.values()) {
      for (const photo of open.photos) if (this.selectedMembers.has(photo.id)) photos.push(photo);
    }
    return photos;
  }

  /**
   * The same selection as **photographs**, a collapsed stack row standing for every frame in it.
   *
   * **Picking a stack is picking what is in it**, and that is already what the server resolves a
   * selected stack row to (§19.6.1) - so a reader that counted the row as one described a smaller
   * thing than the action about to run, and the merge menu refused a stack of four as "too few".
   * Expanding here rather than at each call site is the point: nothing has to know it is looking at
   * a stack, and a reader that forgets to ask gets the wrong answer quietly.
   *
   * `stackMembers` is what makes it possible, and a stack missing from it expands to nothing rather
   * than to its row - the count then falls short of `selectionCount` and every caller's own
   * "is the whole selection loaded" guard refuses, which is the same sample rule as above.
   */
  @computed get selectedLoadedPhotos(): PhotoSummary[] {
    return this.selectedLoadedRows.flatMap((row) => {
      if (row.stack_size <= 1 || row.stack_id == null) return [row];
      return this.stacks.stackMembers.get(row.stack_id) ?? [];
    });
  }

  // Only the rows that are a file. What reads this asks whether the selection reaches into the
  // bin folder, and a row with no file is in no folder at all.
  @computed get selectedLoadedPaths(): string[] {
    return this.selectedLoadedPhotos.map((photo) => photo.file_path).filter((path) => path != null);
  }

  /**
   * The verdict and the rating the whole selection carries, where it carries
   * one, and null for either where it does not.
   *
   * Null covers both "mixed" and "unset", which the bulk bar's marks want to
   * draw the same way: a control lights up only when every selected photograph
   * has the mark, and pressing a lit one clears it exactly as a tile's does.
   *
   * The one place a sample is *not* good enough, so this answers null unless the
   * loaded rows are the whole selection. Off the sample alone, "select all" over
   * two hundred thousand photographs would light the verdict from the screenful
   * the client happens to hold, and pressing it would clear a verdict on every
   * one it has never seen.
   */
  @computed get selectedMarks(): { triage: Triage | null; rating: number | null } {
    const photos = this.selectedLoadedPhotos;
    if (photos.length !== this.selectionCount) return { triage: null, rating: null };
    const first = photos[0];
    if (first == null) return { triage: null, rating: null };
    let triage: Triage | null = first.triage;
    let rating: number | null = first.rating;
    for (const photo of photos) {
      if (photo.triage !== triage) triage = null;
      if (photo.rating !== rating) rating = null;
    }
    return { triage, rating };
  }

  /** Null unless the loaded rows are the whole selection. */
  @computed get selectedHiding(): { hidden: number; shown: number } | null {
    const photos = this.selectedLoadedPhotos;
    if (photos.length !== this.selectionCount) return null;
    const hidden = photos.filter((photo) => photo.is_hidden).length;
    return { hidden, shown: photos.length - hidden };
  }

  /**
   * Whether the selection holds a stack, which is what "Unstack" is offered for.
   *
   * A **sample**, like `selectedLoadedPaths`: only the rows this client is
   * holding can be asked, so a selection reaching further may cover stacks this
   * says nothing about. The server takes them all apart regardless - what is at
   * stake here is only whether the action is offered, and every stack the reader
   * can see is one they are holding a row for.
   */
  @computed get hasSelectedStack(): boolean {
    // Uncollapsed, a row is the photograph and not the stack it belongs to
    // (§19.5.4), so the listing has no stack in it to unmake.
    if (this.listing.expandStacks) return false;
    for (const [index, row] of this.listing.rows) {
      if (row.stack_size > 1 && this.selection.has(index)) return true;
    }
    return false;
  }

  /**
   * The selection as stack triage asks about it: one stack, whole and on its own,
   * or which way it falls short of that.
   *
   * A **sample**, like `hasSelectedStack`, and it errs towards refusing: a
   * selection reaching rows this client never held reads as more than a stack
   * rather than as a stack whose rest nobody can see.
   */
  @computed get selectedStack(): StackSelection {
    // Uncollapsed, a row is the photograph and not the stack it belongs to
    // (§19.5.4), so the listing has no stack in it to triage.
    if (this.listing.expandStacks) return { kind: 'none' };
    // Rows, because the question is which *tile* was picked: expanded, a collapsed stack's row is
    // its members, and `stack_size > 1` - the thing that says "this tile is the whole stack" -
    // would be gone from every one of them.
    const photos = this.selectedLoadedRows;
    if (photos.length !== this.selectedEntries) return { kind: 'extra' };
    const stackIds = new Set<string>();
    let loose = false;
    for (const photo of photos) {
      if (photo.stack_id == null) loose = true;
      else stackIds.add(photo.stack_id);
    }
    const [stackId] = stackIds;
    if (stackId == null) return { kind: 'none' };
    if (loose || stackIds.size > 1) return { kind: 'extra' };
    // A collapsed row stands for its whole stack; picked out of an open band, a
    // member stands only for itself, so the band is what says they are all here.
    const open = this.stacks.expansions.get(stackId);
    const whole =
      photos.some((photo) => photo.stack_size > 1) ||
      (open != null && open.photos.every((photo) => this.selectedMembers.has(photo.id)));
    return whole ? { kind: 'stack', stackId } : { kind: 'partial' };
  }

  @computed get mergeCandidate(): MergeCandidate {
    // In photographs, not in rows: a merge is of frames, and one selected stack tile is as many of
    // them as the stack holds.
    const count = this.selectionCount;
    if (count < 2) return { kind: 'tooFew' };
    if (count > MERGE_MAX_FRAMES) return { kind: 'tooMany' };
    const photos = this.selectedLoadedPhotos;
    if (photos.length !== count) return { kind: 'unresolved' };
    if (photos.some((photo) => isComposite(photo))) return { kind: 'hasComposite' };
    const libraryId = photos[0]?.library_id;
    if (libraryId != null && photos.some((photo) => photo.library_id !== libraryId)) {
      return { kind: 'mixedLibraries' };
    }
    return { kind: 'ready', frames: photos };
  }

  /**
   * The first photograph of the selection in listing order, which is the one a
   * banner is set from, and null where this client cannot name it.
   *
   * Positions before the members hanging off them, and neither map is kept in
   * order: rows arrive in whatever order the reader scrolled them into.
   */
  @computed get firstSelectedPhotoId(): string | null {
    // The lowest selected position, rather than the whole selection being loaded
    // as `selectedMarks` and `selectedStack` want: only the *first* photograph is
    // being named here, so a Select all whose top is on screen answers exactly
    // while the rest of it is still unloaded. Nothing sorts above that position -
    // a band's members hang below the row they belong to.
    const lowest = this.selection.ranges[0]?.start;
    if (lowest != null && !this.listing.rows.has(lowest)) return null;
    const picks: { position: number; member: number; id: string }[] = [];
    for (const [position, row] of this.listing.rows) {
      if (this.selection.has(position)) picks.push({ position, member: -1, id: row.id });
    }
    for (const open of this.stacks.expansions.values()) {
      open.photos.forEach((photo, member) => {
        if (this.selectedMembers.has(photo.id)) picks.push({ position: open.position, member, id: photo.id });
      });
    }
    picks.sort((a, b) => a.position - b.position || a.member - b.member);
    return picks[0]?.id ?? null;
  }

  /**
   * Whether the selection is entirely photographs this shoot does not hold,
   * which is when "Remove from" it is not an action at all.
   *
   * A shoot lists the whole of a stack that reaches out of it and dims the
   * members filed elsewhere (§19.6.1), so picking one of those out of a band is
   * an ordinary way to select nothing the shoot contains - and the server would
   * decline every id in the request.
   *
   * False unless the loaded rows are the whole selection, for `selectedMarks`'
   * reason: off a screenful of a Select all, the button would come and go with
   * whatever had scrolled into view.
   */
  @computed get selectionOutsideShoot(): boolean {
    const source = this.listing.source;
    if (source?.kind !== 'shoot') return false;
    const photos = this.selectedLoadedPhotos;
    if (photos.length !== this.selectionCount) return false;
    return !photos.some((photo) => photo.shoot_id === source.shootId);
  }

  /**
   * Whether anything in the selection is in a shoot already, which decides
   * whether filing it into one is an add or a move.
   *
   * A **sample**, like `selectedLoadedPaths`: what it settles is a word on a
   * menu, and the file moves either way.
   */
  @computed get selectionInAShoot(): boolean {
    return this.selectedLoadedPhotos.some((photo) => photo.shoot_id != null);
  }

  /**
   * The one shoot the whole selection is already in, which is the one it cannot be
   * filed into: offering it is offering a move to where the photographs are.
   *
   * Not read off the collection on screen. A shoot's grid is the obvious way to
   * hold such a selection, but a library's grid holds one the moment the reader
   * picks out photographs from a single shoot's folder - and the row is as
   * pointless there.
   *
   * Answers null unless the loaded rows are the whole selection, for
   * `selectedMarks`' reason: off a screenful of a Select all this would hide a
   * shoot the rows out of view are not in.
   */
  @computed get selectionShootId(): string | null {
    const photos = this.selectedLoadedPhotos;
    if (photos.length === 0 || photos.length !== this.selectionCount) return null;
    const shootId = photos[0]?.shoot_id ?? null;
    if (shootId == null) return null;
    return photos.every((photo) => photo.shoot_id === shootId) ? shootId : null;
  }

  // Where the viewport has to start, in content pixels, for the keyboard cursor
  // to be on screen - or null when it already is. Answered here rather than by
  // asking the focused tile to scroll itself into view: key repeat outruns
  // rendering, so the cursor lands several rows outside the window it was moved
  // from, and a tile that was never mounted cannot scroll anything - the cull
  // simply lost sight of the cursor.
  @computed get focusContentTop(): number | null {
    if (this.focusIndex < 0 || this.listing.total === 0) return null;
    if (this.listing.mode === 'masonry') {
      // No row arithmetic to land on, so this goes as far as the block: within
      // one, the tile is mounted and near enough.
      const block = this.listing.blockOf(this.focusIndex);
      const { from, to } = this.listing.mountedBlocks;
      return block >= from && block < to ? null : Math.max(0, this.listing.blockTops[block] ?? 0);
    }
    // Through the bands, because the scroll is in display rows: with one open
    // above the cursor, the row the photo is drawn on is further down than its
    // row in the collection, and scrolling to the latter lands a whole band's
    // height short of the tile every time.
    const row = displayRowOf(Math.floor(this.focusIndex / this.listing.columns), this.listing.bands, this.listing.columns);
    const top = row * this.listing.rowHeight;
    // The cell, not the row pitch: the gap under it is not part of the tile, and
    // scrolling to clear it would overshoot by one gap every time.
    const bottom = top + this.listing.rowHeight - GRID_GAP;
    if (top < this.listing.rail.at) return Math.max(0, top);
    if (bottom > this.listing.rail.at + this.listing.viewportHeight) {
      return Math.max(0, bottom - this.listing.viewportHeight);
    }
    return null;
  }
}

import { action } from 'mobx';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import type { Span } from '../../../ui/virtual_rows';
import { type IndexSample, SelectionRanges, rebase } from '../selection';
import type { Expansion } from './bands';
import type { ListingStore } from './listing_store';
import type { MarksStore } from './marks_store';
import type { StacksStore } from './stacks_store';
import type { ViewerStore } from '../viewer/viewer_store';

export class SelectionPresenter {
  private sweepBase: SelectionRanges | null = null;
  private memberSweepBase: ReadonlySet<string> | null = null;

  constructor(
    private readonly listing: ListingStore,
    private readonly store: MarksStore,
    private readonly viewer: ViewerStore,
    private readonly stacks: StacksStore,
  ) {}

  // The pointer moving the cursor, which every click does so that the cull keys
  // carry on from what was last touched. It draws nothing: a ring a click left
  // behind outlives the gesture that made it and marks a photograph nobody is
  // about to act on (§18.3.1).
  @action.bound
  focusAt(index: number): void {
    this.moveCursor(index, false);
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
    const at = this.viewer.detailIndex;
    if (at >= 0) this.store.focusIndex = at;
  }

  // The cursor moves without choosing anything: a selection is entered
  // deliberately (§18.3.1), and arrowing through a shoot is browsing. Building one
  // from the keyboard is Space, which toggles without moving.
  @action.bound
  moveFocus(delta: number): void {
    this.moveCursor(this.store.focusIndex < 0 ? 0 : this.store.focusIndex + delta, true);
  }

  // Anywhere in the collection, not just in what is loaded: the cursor walks the
  // whole thing, and the tile it lands on is at most a row outside the rendered
  // window, which the overscan already has mounted.
  @action
  private moveCursor(index: number, shown: boolean): void {
    if (this.listing.total === 0) return;
    this.store.focusIndex = Math.max(0, Math.min(index, this.listing.total - 1));
    this.store.showsCursor = shown;
  }

  @action.bound
  toggle(index: number): void {
    if (index < 0) return;
    const selected = !this.store.selection.has(index);
    this.store.selection = this.store.selection.toggle(index);
    this.store.lastToggled = { position: index, selected };
  }

  // Shift-click spans everything between the last photo picked on its own and
  // this one, which is how you take a burst without clicking forty times. One
  // range, however long, so a burst and a whole library cost the same.
  @action.bound
  extendTo(index: number): void {
    const anchor = this.store.lastToggled;
    // The cursor stands in for the anchor when nothing has been toggled yet:
    // arrowing to one photo and shift-clicking another is the same gesture as in
    // any file manager, and it is what a first shift-click has to reach for.
    const at = anchor?.position ?? this.store.focusIndex;
    if (at < 0 || index < 0) {
      this.toggle(index);
      this.focusAt(index);
      return;
    }
    const [from, to] = at <= index ? [at, index] : [index, at];
    // The anchor's own verb, so unpicking one photo of a run and shift-clicking
    // along it takes that stretch out rather than putting it back in.
    this.store.selection =
      anchor?.selected === false ? this.store.selection.remove(from, to) : this.store.selection.add(from, to);
    // Moved here rather than by the caller, which would have to know to focus
    // *after* extending: focus is the fallback anchor, so focusing first would
    // make every range start and end on the photo just clicked.
    this.focusAt(index);
  }

  // A long press: picks the photo under the finger and anchors the drag after it.
  @action.bound
  startSweep(index: number): void {
    this.focusAt(index);
    this.toggle(index);
    this.sweepBase = this.store.selection;
  }

  // From the selection the sweep started on rather than the current one, so a
  // finger dragged back shrinks the span again.
  @action.bound
  sweepTo(index: number): void {
    const anchor = this.store.lastToggled;
    if (this.sweepBase == null || anchor == null || index < 0) return;
    const [from, to] = anchor.position <= index ? [anchor.position, index] : [index, anchor.position];
    this.store.selection = anchor.selected ? this.sweepBase.add(from, to) : this.sweepBase.remove(from, to);
    this.focusAt(index);
  }

  // The same inside an open band, whose members have no position.
  @action.bound
  startMemberSweep(id: string): void {
    const photo = this.stacks.memberById(id);
    if (photo == null) return;
    this.toggleMember(photo);
    this.memberSweepBase = this.store.selectedMembers;
  }

  @action.bound
  sweepMembersTo(id: string): void {
    const photo = this.stacks.memberById(id);
    if (this.memberSweepBase == null || photo == null) return;
    const span = this.memberSpan(photo, this.memberSweepBase);
    if (span != null) this.store.selectedMembers = span;
  }

  @action.bound
  endSweep(): void {
    this.sweepBase = null;
    this.memberSweepBase = null;
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
    this.store.selection = SelectionRanges.of(0, this.listing.total - 1);
    this.store.lastToggled = null;
  }

  // The reader dropping the selection, from the bar's Clear. The cursor stays: it
  // is where they are in the collection, not what they have chosen, and the cull
  // keys go on acting on it.
  @action.bound
  clearSelection(): void {
    this.clearSelectedPositions();
    this.clearMemberSelection();
  }

  // Escape, which is the reader stepping back out of the grid rather than merely
  // unchoosing: the ring goes with the selection, because nothing else puts away
  // one the keyboard drew and a cull key acting on an unmarked tile is a verdict
  // nobody can see the target of.
  @action.bound
  dismissSelection(): void {
    this.clearSelection();
    this.store.showsCursor = false;
  }

  // The keyboard taking the grid over on a key that does not move the cursor - a
  // verdict, a rating, Space - so that what it acts on is drawn before it acts.
  @action.bound
  showCursor(): void {
    if (this.store.focusIndex >= 0) this.store.showsCursor = true;
  }

  @action.bound
  setShowTriage(show: boolean): void {
    this.store.showTriage = show;
  }

  @action.bound
  setShowRating(show: boolean): void {
    this.store.showRating = show;
  }

  @action.bound
  rebasePositions(samples: IndexSample[], domain: SelectionRanges, whole: boolean): void {
    if (whole) {
      this.store.selection = SelectionRanges.of(0, this.listing.total - 1);
      return;
    }
    if (this.store.hasSelection) this.store.selection = rebase(this.store.selection, samples, domain);
    this.store.focusIndex = this.moved(this.store.focusIndex, samples, domain);
    const anchor = this.store.lastToggled;
    if (anchor != null) this.store.lastToggled = { ...anchor, position: this.moved(anchor.position, samples, domain) };
  }

  private moved(index: number, samples: IndexSample[], domain: SelectionRanges): number {
    if (index < 0) return index;
    return rebase(SelectionRanges.of(index, index), samples, domain).ranges[0]?.start ?? index;
  }

  @action.bound
  clampFocus(): void {
    if (this.store.focusIndex >= this.listing.total) this.store.focusIndex = this.listing.total - 1;
  }

  @action.bound
  resetCollection(): void {
    this.store.selectedMembers = new Set();
    this.store.focusIndex = -1;
  }

  @action.bound
  setDisplay(showTriage: boolean, showRating: boolean): void {
    this.store.showTriage = showTriage;
    this.store.showRating = showRating;
  }

  @action.bound
  retainMembers(live: ReadonlySet<string>): void {
    this.store.selectedMembers = new Set([...this.store.selectedMembers].filter((id) => live.has(id)));
  }

  @action.bound
  dropMembers(dropped: ReadonlySet<string>): void {
    this.store.selectedMembers = new Set([...this.store.selectedMembers].filter((id) => !dropped.has(id)));
  }

  @action.bound
  replace(selection: SelectionRanges, focusIndex: number, selectedMembers: ReadonlySet<string> = new Set()): void {
    this.store.selectedMembers = new Set(selectedMembers);
    this.store.selection = selection;
    this.store.focusIndex = focusIndex;
  }

  // The positions alone, for a collection whose positions now hold something else.
  // The cursor stays, since a filter is a narrower view of the same photographs
  // (§18.3.2) - and it is not selected here, because until the next block lands it
  // may name a row this collection does not have.
  @action.bound
  clearSelectedPositions(): void {
    this.store.selection = SelectionRanges.EMPTY;
    this.store.lastToggled = null;
  }

  // What an action leaves behind, once the photos it acted on are no longer the
  // selection: nothing chosen, and the cursor where it was, so a cull that bins
  // the photo it is on carries on from the row that took its place.
  // Members go with the positions: the action covered both (§19.6.1), so leaving
  // the band's picks ringed would offer them to the next one again.
  @action.bound
  dropConsumedSelection(): void {
    this.clearSelection();
    // A cull that binned the last rows leaves the cursor past the end of what is
    // left, and `Del` there acts on nothing.
    this.store.focusIndex = Math.min(this.store.focusIndex, this.listing.total - 1);
  }

  @action.bound
  toggleMember(photo: PhotoSummary): void {
    const open = this.stacks.bandOf(photo);
    if (open != null) this.nameBandMembers(open);
    const selected = new Set(this.store.selectedMembers);
    const picked = !selected.delete(photo.id);
    if (picked) selected.add(photo.id);
    this.store.selectedMembers = selected;
    this.store.lastToggledMember = { id: photo.id, selected: picked };
  }

  // Shift-click inside an open band. The span is over the band's own order, which
  // is the collection's (`bandScope`), so it reads the way a run of rows does.
  @action.bound
  extendMembersTo(photo: PhotoSummary): void {
    const open = this.stacks.bandOf(photo);
    if (open != null) this.nameBandMembers(open);
    const span = this.memberSpan(photo, this.store.selectedMembers);
    // Nothing in this band to reach back to - a first shift-click, or an anchor
    // left in a band that has since closed - so it is an ordinary pick.
    if (span == null) this.toggleMember(photo);
    else this.store.selectedMembers = span;
  }

  // `base` with the members between the anchor and `photo` given the anchor's verb.
  private memberSpan(photo: PhotoSummary, base: ReadonlySet<string>): Set<string> | null {
    const ids = this.stacks.bandOf(photo)?.photos.map((member) => member.id) ?? [];
    const anchor = this.store.lastToggledMember;
    const to = ids.indexOf(photo.id);
    const from = anchor == null ? -1 : ids.indexOf(anchor.id);
    if (anchor == null || to < 0 || from < 0) return null;
    const selected = new Set(base);
    for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      if (anchor.selected) selected.add(id);
      else selected.delete(id);
    }
    return selected;
  }

  // A selected stack row stands for every photograph under it, so taking one
  // member out of its open band has to leave the rest chosen - which a run over
  // the row alone cannot say. Naming them makes the same selection out of things
  // a single pick can be taken off.
  @action
  private nameBandMembers(open: Expansion): void {
    if (!this.store.bandRowSelected(open)) return;
    this.store.selection = this.store.selection.remove(open.position, open.position);
    this.store.selectedMembers = new Set([...this.store.selectedMembers, ...open.photos.map((photo) => photo.id)]);
  }

  @action.bound
  clearMemberSelection(): void {
    this.store.selectedMembers = new Set();
    this.store.lastToggledMember = null;
  }
}

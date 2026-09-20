import { computed, observable } from 'mobx';
import { type Span, visibleRows } from '../ui/virtual_rows';

/** A row of a collection list: a shoot, a folder the shoots skipped, an album. */
export interface CollectionRow {
  /** Identity across renumbering: a folder path for a shoot, an id for an album. */
  key: string;
  name: string;
  /** The line under the name, empty where the name already says everything. */
  meta: string;
  bannerPhotoId: string | null;
  /** Where a click or Enter goes, null for a row that opens onto nothing. */
  href: string | null;
  depth: number;
  /** Whether it has anything under it to open, so a chevron is only offered where it does. */
  expandable: boolean;
  /**
   * A folder nobody has claimed, a listing that is not a collection at all, or a collection the
   * reader has put away and is being shown on purpose (§12.4).
   */
  tone?: 'untracked' | 'virtual' | 'hidden';
}

// The pitch every row is fixed to, handed to the row's style rather than
// written down on both sides: a height the two disagreed on drifts a little on
// every row, and a folder tree is enough rows for a little to become a lot
// (§18.3.2 says the same of the grid). `box-sizing: border-box`, so this is the
// whole row including its border.
export const LIST_ROW_H = 47;

// Everything a virtually-scrolled list of collections holds, whatever the
// collections are. Shoots and Albums are one list with two row sources, so the
// keyboard cursor, the rename in flight and the window arithmetic live here and
// the subclass answers only `rows`.
export abstract class CollectionListStore<Row extends CollectionRow> {
  @observable accessor loading = false;
  @observable accessor error: string | null = null;
  // Written by the presenter from a ResizeObserver and the scroll handler, so
  // every layout question below is a computed rather than a DOM read (§18.2).
  @observable accessor viewportHeight = 0;
  @observable accessor scrollTop = 0;
  // Which row is being renamed, and what has been typed. Here rather than in the
  // row's own state because rows are mounted only while they are on screen:
  // scrolling unmounts one mid-edit, and React fires no blur on unmount, so a
  // half-typed name simply disappeared.
  @observable accessor renamingKey: string | null = null;
  @observable accessor renameDraft = '';
  // The keyboard cursor, held as a row key rather than a row index. Rows are
  // renumbered by every expand, collapse and view change, so an index would point
  // at a different row afterwards; a key names the same row whatever the list does
  // around it. (The grid keys its cursor by index because a position is all a
  // sparse collection has, §18.3.2.)
  @observable accessor cursorKey: string | null = null;
  // Bumped by every cursor command, so following it can react to being *asked*
  // rather than to the index changing. Flat and Tree list the same shoots in the
  // same order, so switching between them leaves the index alone - and a scroll
  // away from the cursor changes nothing at all - yet both want the list brought
  // back to the cursor.
  @observable accessor cursorSeq = 0;
  // Where the cursor was when its row was last on the list, so a collapse or a
  // delete can put it back somewhere near rather than at the top. -1 until the
  // reader has ever had one, which is a different thing from "at the first row".
  @observable accessor lastCursorIndex = -1;
  /** Rows whose children are drawn; every ancestor of a shoot is one. */
  @observable.shallow accessor expanded = new Set<string>();

  abstract get rows(): Row[];

  /** Whether rows sit under one another here, so a leaf reserves the chevron's width. */
  get nests(): boolean {
    return false;
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.rows.length === 0;
  }

  // Mirroring gives a library a shoot per folder, so this list is as long as the
  // tree is: the same reason the gallery scrolls virtually (§18.3.2), reached
  // from the other direction. Rows are uniform, so the whole thing is arithmetic
  // over the viewport and one row height.
  //
  // Struct, as the gallery's `visibleSpan` is: the scroll position is sampled once
  // a frame but the rows on screen change only when one crosses the fold, and
  // comparing the value rather than its inputs is what keeps the slice below - and
  // so every mounted row - out of the per-frame path.
  @computed.struct get visible(): Span {
    return visibleRows(this.scrollTop, this.viewportHeight, LIST_ROW_H, this.rows.length);
  }

  /** The rows actually mounted, and where to put the window holding them. */
  @computed get visibleRowsSlice(): Row[] {
    return this.rows.slice(this.visible.from, this.visible.to);
  }

  @computed get visibleTop(): number {
    return this.visible.from * LIST_ROW_H;
  }

  @computed get rowIndexByKey(): Map<string, number> {
    return new Map(this.rows.map((row, index) => [row.key, index]));
  }

  /** Where the cursor sits now, or -1 if its row is no longer on the list. */
  @computed get cursorIndex(): number {
    return this.cursorKey == null ? -1 : (this.rowIndexByKey.get(this.cursorKey) ?? -1);
  }

  @computed get cursorRow(): Row | null {
    return this.rows[this.cursorIndex] ?? null;
  }

  // Where the scroll has to go for the cursor to be on screen, or null if it
  // already is. Computed from the store's own geometry rather than from the
  // cursor's element, which is the whole point: the row it names may never have
  // been mounted, so there is nothing to measure or to call scrollIntoView on.
  @computed get cursorScrollTop(): number | null {
    if (this.cursorIndex < 0) return null;
    const top = this.cursorIndex * LIST_ROW_H;
    if (top < this.scrollTop) return top;
    // The row's own height, not the pitch past it: scrolling to clear the next
    // row's edge would overshoot by a row every time.
    const bottom = top + LIST_ROW_H;
    if (bottom > this.scrollTop + this.viewportHeight) return bottom - this.viewportHeight;
    return null;
  }

  @computed get scrollHeight(): number {
    return this.rows.length * LIST_ROW_H;
  }
}

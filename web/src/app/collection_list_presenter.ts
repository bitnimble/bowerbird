import { action } from 'mobx';
import type { CollectionListStore, CollectionRow } from './collection_list_store';

// The single writer for a collection list's scroll, cursor and rename. Shoots
// and Albums differ in what a row is and what renaming one costs on the wire;
// everything between the keyboard and the store is the same list.
export abstract class CollectionListPresenter<Store extends CollectionListStore<CollectionRow>> {
  // Which cursorSeq we last put DOM focus on. Survives row remounts so scrolling
  // a still-cursored row back into the window does not yank focus off a control
  // the reader tabbed to while it was off-screen.
  private cursorFocusSeq = -1;

  constructor(protected readonly store: Store) {}

  // True once per cursorSeq: the cursored row should take focus. Remounts of the
  // same cursor do not ask again.
  claimCursorFocus(): boolean {
    if (this.cursorFocusSeq === this.store.cursorSeq) return false;
    this.cursorFocusSeq = this.store.cursorSeq;
    return true;
  }

  /** Everything the list remembers about rows it is about to stop showing. */
  @action.bound
  protected forgetRows(): void {
    this.store.cursorKey = null;
    // Where the cursor was, as well as the cursor: the first arrow key resumes
    // from this when nothing is cursored, and row fifteen of one list is not row
    // fifteen of the next.
    this.store.lastCursorIndex = -1;
    this.store.scrollTop = 0;
    this.store.expanded = new Set();
    // A rename in flight names a row by key, and two lists can hand the same key
    // to different rows - a folder path repeated across libraries - so an edit
    // left standing reopens on whatever the new list has there.
    this.store.renamingKey = null;
    this.store.renameDraft = '';
    this.cursorFocusSeq = -1;
  }

  // The scroller's own numbers, written straight to the store so nothing else
  // has to read the DOM to know what is on screen (§18.2).
  @action.bound
  setViewport(height: number): void {
    this.store.viewportHeight = height;
  }

  @action.bound
  setScrollTop(top: number): void {
    this.store.scrollTop = top;
  }

  // The keyboard cursor. Kept in the store rather than as focus on a row element,
  // because rows are mounted only while they are on screen: scrolling past the
  // cursor would otherwise drop it on the floor and leave the browser focusing
  // the document body (§18.3.4).
  // Only ever set to a row that is actually on the list: a cursor pointing at
  // something the list does not show has no ring, puts no row in the tab order,
  // and sends the next arrow key back to the top.
  @action.bound
  setCursor(key: string | null): void {
    if (key == null) {
      this.store.cursorKey = null;
      return;
    }
    const index = this.store.rowIndexByKey.get(key);
    if (index == null) return;
    this.putCursor(index);
  }

  @action.bound
  moveCursor(delta: number): void {
    const rows = this.store.rows;
    if (rows.length === 0) return;
    // Three cases: a live cursor moves from itself; one whose row has gone
    // resumes from where that row was; and a list never touched starts at the
    // end the reader is heading away from, so the first ↓ is the first row.
    const from =
      this.store.cursorIndex >= 0
        ? this.store.cursorIndex
        : this.store.lastCursorIndex >= 0
          ? this.store.lastCursorIndex - Math.sign(delta)
          : delta > 0
            ? -1
            : rows.length;
    this.putCursor(Math.max(0, Math.min(from + delta, rows.length - 1)));
  }

  @action.bound
  private putCursor(index: number): void {
    this.store.cursorKey = this.store.rows[index]!.key;
    this.store.lastCursorIndex = index;
    this.store.cursorSeq++;
  }

  // Right opens a row and then walks into it; left closes one, or steps out to
  // the nearest ancestor that is a row. The arrows a tree is expected to answer,
  // and on a flat list the second half of each simply finds nothing.
  openCursor(): void {
    const row = this.store.cursorRow;
    if (row == null) return;
    if (row.expandable && !this.store.expanded.has(row.key)) {
      this.toggleExpanded(row.key);
      return;
    }
    this.moveCursor(1);
  }

  closeCursor(): void {
    const row = this.store.cursorRow;
    if (row == null) return;
    if (row.expandable && this.store.expanded.has(row.key)) {
      // The row's children are about to go; the cursor sits on the row itself,
      // which stays.
      this.toggleExpanded(row.key);
      return;
    }
    for (let key = this.parentKey(row.key); key != null; key = this.parentKey(key)) {
      if (this.store.rowIndexByKey.has(key)) {
        this.setCursor(key);
        return;
      }
    }
  }

  /** The row a left-arrow steps out to, for a list that nests. */
  protected parentKey(_key: string): string | null {
    return null;
  }

  // Puts the cursor back on a real row after something removed the one it was on
  // - a collapse, a delete, a sync tick. Held where the row was rather than reset,
  // so the reader carries on from the same place in the list.
  @action.bound
  settleCursor(): void {
    if (this.store.cursorKey == null || this.store.cursorIndex >= 0) return;
    const rows = this.store.rows;
    if (rows.length === 0) {
      this.store.cursorKey = null;
      return;
    }
    this.putCursor(Math.max(0, Math.min(this.store.lastCursorIndex, rows.length - 1)));
  }

  @action.bound
  toggleExpanded(key: string): void {
    if (!this.store.expanded.has(key)) {
      this.store.expanded.add(key);
      return;
    }
    this.store.expanded.delete(key);
    // Collapsing takes rows away, and the cursor may have been on one of them.
    this.settleCursor();
  }

  @action.bound
  startRename(key: string, current: string): void {
    this.store.renamingKey = key;
    this.store.renameDraft = current;
  }

  @action.bound
  setRenameDraft(draft: string): void {
    this.store.renameDraft = draft;
  }

  @action.bound
  cancelRename(): void {
    this.store.renamingKey = null;
    this.store.renameDraft = '';
  }

  // Committed against the row at the key being renamed rather than an object
  // captured when the edit began: a sync landing mid-edit can replace the row.
  async commitRename(): Promise<void> {
    const key = this.store.renamingKey;
    const index = key == null ? undefined : this.store.rowIndexByKey.get(key);
    const row = index == null ? null : this.store.rows[index]!;
    const next = this.store.renameDraft.trim();
    this.cancelRename();
    if (row == null || next === '' || next === row.name) return;
    await this.renameRow(row.key, next);
  }

  protected abstract renameRow(key: string, name: string): Promise<void>;

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  @action.bound
  protected beginLoad(): void {
    this.store.loading = true;
    this.store.error = null;
  }

  @action.bound
  protected fail(error: string): void {
    this.store.loading = false;
    this.store.error = error;
  }
}

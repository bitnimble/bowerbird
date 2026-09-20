import { action, reaction } from 'mobx';
import { atRailWall, recentred } from './grid_layout';
import type { ScrollRailStore } from './scroll_rail_store';

/** The only writer of one ScrollRailStore (DESIGN §18.3.2). */
export class ScrollRailPresenter {
  constructor(private readonly rail: ScrollRailStore) {}

  /**
   * Starts watching, and returns the way to stop.
   *
   * Not the constructor's work: a rail belonging to a view is built while that
   * view renders, and a subscription made there is one React's double-invoked
   * mount tears down and never puts back.
   */
  watch(): () => void {
    // `anchor` clamps to a collection that may have shrunk, but the raw value it
    // clamps has to come down with it: binning most of a library shortens the
    // collection and undoing the bin lengthens it again, and an anchor left where
    // it was springs the reader back to a position they were clamped out of a
    // moment before.
    return reaction(() => this.rail.limit, this.settle);
  }

  @action.bound
  private settle(): void {
    const clamped = this.rail.rawAnchor - this.rail.anchor;
    this.rail.rawAnchor = this.rail.anchor;
    if (clamped === 0) return;
    // The rail takes what the anchor was clamped out of, or `at` loses it: a
    // masonry block measuring short of its estimate shortens the collection, so an
    // anchor coming down alone is a jump per block boundary near the end of one.
    this.rail.top = Math.min(this.rail.reach, Math.max(0, this.rail.top + clamped));
  }

  /** Where the scroller has got to. */
  @action.bound
  setTop(top: number): void {
    this.rail.top = top;
    // The one place the rail is moved rather than followed. Writing the scroll
    // offset mid-fling cancels the fling, so it waits until the reader is near an
    // end.
    if (!atRailWall(top, this.contentLength, this.viewportLength)) return;
    const put = recentred(this.rail.anchor, top, this.contentLength, this.viewportLength);
    this.rail.rawAnchor = put.anchorTop;
    this.rail.top = put.railTop;
  }

  /**
   * Moves the view `by` content pixels from where it was anchored. Whatever the
   * anchor cannot absorb goes to the rail, which the view follows (§18.3.2); that
   * only happens once the anchor is out of travel, which for a collection shorter
   * than the rail is always.
   *
   * `wasAnchoredAt` has to be read *before* whatever displaced the reader, because
   * every caller shrinks the collection as it displaces them. Read after, `anchor`
   * has already been clamped down by a smaller `limit` and `by` counts that clamp
   * a second time: closing a band with the anchor at its limit threw the reader a
   * band-height past the band, and a masonry block measuring shorter than its
   * estimate threw them from 80% of the collection to near the top.
   */
  @action.bound
  shift(by: number, wasAnchoredAt: number): void {
    if (by === 0) return;
    const target = wasAnchoredAt + by;
    const anchor = Math.min(this.rail.limit, Math.max(0, target));
    this.rail.rawAnchor = anchor;
    // Clamped to the rail rather than left for the browser to clamp on the write:
    // a collection that lost most of its height under the reader - every masonry
    // block measuring far short of its estimate - has no such position any more,
    // and the store must not claim one it would only be corrected out of a frame
    // later by a scroll event.
    this.rail.top = Math.min(this.rail.reach, Math.max(0, this.rail.top + (target - anchor)));
  }

  /**
   * Put a content position at the start of the viewport, for a jump the reader
   * asked for - the keyboard cursor leaving the window, Home, End, the thumb, the
   * wheel over the bar.
   */
  @action.bound
  scrollTo(contentTop: number): void {
    // Clamped, because masonry answers `focusContentTop` with a block top, and the
    // last block is often shorter than the viewport - so the target can sit past
    // where the collection can actually be scrolled to.
    const target = Math.min(this.rail.travel, Math.max(0, contentTop));
    // Leaving the rail where it is whenever the target is inside it keeps arrowing
    // through a collection an ordinary scroll rather than a re-anchor per keystroke.
    const within = target - this.rail.anchor;
    const reachable = within >= 0 && within <= this.rail.reach;
    const put = reachable
      ? { anchorTop: this.rail.anchor, railTop: within }
      : recentred(target, 0, this.contentLength, this.viewportLength);
    this.rail.rawAnchor = put.anchorTop;
    this.rail.top = put.railTop;
  }

  /** Jump to a fraction of the collection: the thumb, and Home and End. */
  @action.bound
  scrollToProgress(progress: number): void {
    this.scrollTo(Math.min(1, Math.max(0, progress)) * this.rail.travel);
  }

  @action.bound
  reset(): void {
    this.rail.top = 0;
    this.rail.rawAnchor = 0;
  }

  private get contentLength(): number {
    return this.rail.content();
  }

  private get viewportLength(): number {
    return this.rail.viewport();
  }
}

import { computed, observable } from 'mobx';
import { anchorLimit, railHeight } from './grid_layout';

/**
 * Where one scrolling view sits inside a collection too long to be an element
 * (§18.3.2): a rail of fixed length whose origin is dragged along the content, so
 * the reader's place is `anchor + top` and the scroller itself never grows past
 * what a browser will lay out.
 *
 * **One axis, and it does not say which.** The gallery scrolls it down the page
 * and the viewer's filmstrip scrolls it across; the recentring, the clamping and
 * the progress are the same arithmetic either way, and two copies of it are two
 * chances to get the hard one wrong.
 *
 * How long the content and the viewport are is the *view's* question - a zoom, a
 * mode, a masonry block that measured - so both are read from it rather than
 * written here, where a rail that had to be told would lag each of them by a
 * frame.
 *
 * Observables and computeds only. Every mutation is on ScrollRailPresenter.
 */
export class ScrollRailStore {
  constructor(
    /** How long the collection is, along this axis, in content pixels. */
    readonly content: () => number,
    /** How much of it the viewport shows. */
    readonly viewport: () => number,
  ) {}

  /** Where the scroller has got to inside the rail: the element's own scroll offset. */
  @observable accessor top = 0;

  // Which content pixel the rail's origin sits at, raw. Read it through `anchor`,
  // which clamps it to a collection that may have shrunk since - a band closing, a
  // masonry block measuring shorter than it was estimated at.
  @observable accessor rawAnchor = 0;

  /** How long the scroller is: the whole collection, until that exceeds the rail. */
  @computed get length(): number {
    return railHeight(this.content());
  }

  /** How far the rail's origin can travel; 0 for a collection the rail covers whole. */
  @computed get limit(): number {
    return anchorLimit(this.content());
  }

  @computed get anchor(): number {
    return Math.min(this.limit, Math.max(0, this.rawAnchor));
  }

  /** Where the viewport starts in the collection, in content pixels. */
  @computed get at(): number {
    return this.anchor + this.top;
  }

  /** How far the rail can be scrolled, which is what every write to `top` is clamped to. */
  @computed get reach(): number {
    return Math.max(0, this.length - this.viewport());
  }

  /** How much of the collection is left to scroll through, in content pixels. */
  @computed get travel(): number {
    return Math.max(0, this.content() - this.viewport());
  }

  /** A position in content pixels, as a position inside the rail. */
  positionOf(contentTop: number): number {
    return contentTop - this.anchor;
  }

  /** How far through the collection the viewport has got, 0 to 1. */
  @computed get progress(): number {
    if (this.travel <= 0) return 0;
    return Math.min(1, Math.max(0, this.at / this.travel));
  }

  /** How much of the collection is on screen, 0 to 1, which is how long the thumb is. */
  @computed get fraction(): number {
    const content = this.content();
    if (content <= 0) return 1;
    return Math.min(1, this.viewport() / content);
  }
}

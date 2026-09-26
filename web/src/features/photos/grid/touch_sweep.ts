import type { PhotosPresenter } from '../photos_presenter';

const HOLD_MS = 400;
const HAPTIC_MS = 15;
const SLOP_PX = 10;
const EDGE_PX = 72;
const MAX_SCROLL_PX_PER_FRAME = 24;

type SweepActions = Pick<
  PhotosPresenter,
  'startSweep' | 'sweepTo' | 'startMemberSweep' | 'sweepMembersTo' | 'endSweep'
>;

/** A row of the collection by its position, or a member of an open band, which has none. */
type Mark = { kind: 'row'; index: number } | { kind: 'member'; id: string };

function markOf(cell: Element): Mark | null {
  const position = cell.getAttribute('aria-posinset');
  if (position != null) return { kind: 'row', index: Number(position) - 1 };
  const id = cell.getAttribute('data-member-id');
  return id == null ? null : { kind: 'member', id };
}

const keyOf = (mark: Mark): string => (mark.kind === 'row' ? `row ${mark.index}` : `member ${mark.id}`);

/**
 * A long press on a tile picks it, and dragging on from there picks the run between, scrolling
 * the grid when the finger nears its top or bottom edge. A drag from a band's member runs over
 * that band, as a shift-click there does.
 */
export class TouchSweep {
  private cell: HTMLElement | null = null;
  private from: Mark | null = null;
  private last = '';
  private x = 0;
  private y = 0;
  private hold: ReturnType<typeof setTimeout> | null = null;
  private held = false;
  private moved = false;
  private frame = 0;
  private top = 0;
  private bottom = 0;
  private edge = EDGE_PX;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly actions: SweepActions,
  ) {
    scroller.addEventListener('touchstart', this.onStart, { passive: true });
    scroller.addEventListener('contextmenu', this.onHeldGesture);
    scroller.addEventListener('dragstart', this.onHeldGesture);
  }

  dispose(): void {
    this.release();
    this.scroller.removeEventListener('touchstart', this.onStart);
    this.scroller.removeEventListener('contextmenu', this.onHeldGesture);
    this.scroller.removeEventListener('dragstart', this.onHeldGesture);
  }

  private readonly onStart = (e: TouchEvent): void => {
    this.release();
    const touch = e.touches[0];
    const cell = e.target instanceof Element ? e.target.closest<HTMLElement>('[role="listitem"]') : null;
    const mark = cell == null ? null : markOf(cell);
    if (e.touches.length !== 1 || touch == null || cell == null || mark == null) return;
    this.x = touch.clientX;
    this.y = touch.clientY;
    this.from = mark;
    // On the tile rather than the scroller: the scroll can unmount it, and touches on a detached
    // target stop bubbling at the root of the detached subtree.
    this.cell = cell;
    cell.addEventListener('touchmove', this.onMove, { passive: false });
    cell.addEventListener('touchend', this.onEnd);
    cell.addEventListener('touchcancel', this.onEnd);
    this.hold = setTimeout(this.begin, HOLD_MS);
  };

  // A browser's own long press, a link menu or a drag of the image, would take the gesture.
  private readonly onHeldGesture = (e: Event): void => {
    if (this.cell != null) e.preventDefault();
  };

  private readonly begin = (): void => {
    this.hold = null;
    const from = this.from;
    if (from == null) return;
    this.held = true;
    if ('vibrate' in navigator) navigator.vibrate(HAPTIC_MS);
    const box = this.scroller.getBoundingClientRect();
    this.top = Math.max(box.top, 0);
    this.bottom = Math.min(box.bottom, window.innerHeight);
    this.edge = Math.min(EDGE_PX, (this.bottom - this.top) / 3);
    this.last = keyOf(from);
    if (from.kind === 'row') this.actions.startSweep(from.index);
    else this.actions.startMemberSweep(from.id);
    this.frame = requestAnimationFrame(this.tick);
  };

  private readonly onMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (touch == null) return;
    if (!this.held) {
      if (Math.hypot(touch.clientX - this.x, touch.clientY - this.y) > SLOP_PX) this.release();
      return;
    }
    e.preventDefault();
    this.x = touch.clientX;
    this.y = touch.clientY;
    this.moved = true;
  };

  private readonly onEnd = (e: TouchEvent): void => {
    // Cancelling the touchend is what stops the click after it opening the photo just picked.
    if (this.held && e.cancelable) e.preventDefault();
    this.release();
  };

  private readonly tick = (): void => {
    const step = this.scrollStep();
    if (step !== 0) this.scroller.scrollBy({ top: step });
    if (step !== 0 || this.moved) {
      this.moved = false;
      this.sweepTo(this.markAt(this.x, Math.min(Math.max(this.y, this.top + 1), this.bottom - 1)));
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private sweepTo(mark: Mark | null): void {
    if (mark == null || mark.kind !== this.from?.kind || keyOf(mark) === this.last) return;
    this.last = keyOf(mark);
    if (mark.kind === 'row') this.actions.sweepTo(mark.index);
    else this.actions.sweepMembersTo(mark.id);
  }

  private scrollStep(): number {
    const above = this.top + this.edge - this.y;
    if (above > 0) return -MAX_SCROLL_PX_PER_FRAME * Math.min(1, above / this.edge);
    const below = this.y - (this.bottom - this.edge);
    if (below > 0) return MAX_SCROLL_PX_PER_FRAME * Math.min(1, below / this.edge);
    return 0;
  }

  // A hit test, per frame of a drag: masonry's packing exists only in layout, so no store can say
  // which tile is under a point. Every element at it rather than the topmost: the bulk bar floats
  // over the grid's foot, exactly where a sweep scrolling down holds its finger.
  private markAt(x: number, y: number): Mark | null {
    for (const element of document.elementsFromPoint(x, y)) {
      const cell = element.closest('[role="listitem"]');
      if (cell != null && this.scroller.contains(cell)) return markOf(cell);
    }
    return null;
  }

  private release(): void {
    if (this.hold != null) clearTimeout(this.hold);
    this.hold = null;
    cancelAnimationFrame(this.frame);
    this.cell?.removeEventListener('touchmove', this.onMove);
    this.cell?.removeEventListener('touchend', this.onEnd);
    this.cell?.removeEventListener('touchcancel', this.onEnd);
    this.cell = null;
    this.from = null;
    this.moved = false;
    if (!this.held) return;
    this.held = false;
    this.actions.endSweep();
  }
}

import { action, comparer, reaction } from 'mobx';
import { readSetting, writeSetting } from '../../../app/local_setting';
import type { PhotosPresenter } from '../photos_presenter';
import { ScrollRailPresenter } from '../grid/scroll_rail_presenter';
import { STRIP_DEFAULT_THICKNESS, STRIP_MAX_THICKNESS, STRIP_MIN_THICKNESS, type StripViewStore } from './strip_view_store';

const THICKNESS_KEY = 'bowerbird.detail.filmstrip.size';

/** The only writer of one StripViewStore (DESIGN §18.5). */
export class StripViewPresenter {
  readonly rail: ScrollRailPresenter;
  private disposers: (() => void)[] = [];

  constructor(
    private readonly store: StripViewStore,
    private readonly photos: PhotosPresenter,
  ) {
    this.rail = new ScrollRailPresenter(store.rail);
    this.setThickness(Number(readSetting(THICKNESS_KEY) ?? '') || STRIP_DEFAULT_THICKNESS);
  }

  /**
   * Starts watching, from the effect that mounts the strip.
   *
   * **Not the constructor**, which runs while the viewer renders: React's
   * double-invoked mount runs an effect's cleanup and then its setup again, so a
   * subscription made at construction is torn down once and never rebuilt - a
   * strip whose rows are evicted as fast as they arrive, for the life of the page.
   */
  watch(): void {
    this.stop();
    // What the strip is over is rows this client has to hold: `neededBlocks` is
    // what keeps a block as much as what fetches one, so a span missing from it
    // has its rows evicted as fast as they land.
    this.disposers = [
      this.rail.watch(),
      reaction(() => this.store.visible, (span) => this.photos.setStripSpan(span), {
        equals: comparer.structural,
        fireImmediately: true,
      }),
      // A stack the reader has stepped into opens, so the strip has a cell to mark
      // the photograph they are on, and closes again behind them.
      reaction(() => this.store.openPhotoStack, (stackId) => void this.photos.followBand(stackId), {
        fireImmediately: true,
      }),
    ];
  }

  /** The strip is mounted only while the viewer is, so it takes its span with it. */
  stop(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.photos.setStripSpan(null);
    // Leaving the viewer is leaving the stack: a band nobody opened has no
    // business standing open in the gallery behind it.
    void this.photos.followBand(null);
  }

  @action.bound
  setViewport(width: number, height: number): void {
    this.store.viewportWidth = width;
    this.store.viewportHeight = height;
  }

  /**
   * Which edge the strip takes, decided by the page from the photograph's shape
   * and the frame it has (`stripEdge`).
   *
   * The rail is in pixels and a cell is a different size on the other axis, so
   * where it is left is meaningless across the swap; the view re-centres on the
   * open photograph instead, which is where the reader was.
   */
  @action.bound
  setAxis(axis: 'x' | 'y'): void {
    this.store.axis = axis;
  }

  @action.bound
  setThickness(thickness: number): void {
    this.store.thickness = Math.min(STRIP_MAX_THICKNESS, Math.max(STRIP_MIN_THICKNESS, Math.round(thickness)));
    writeSetting(THICKNESS_KEY, String(this.store.thickness));
  }

  /**
   * Brings the photograph the viewer has open into the strip, centred.
   *
   * Centred rather than merely on screen: the reader steps forwards and backwards
   * through a cull, and a cell scrolled to the near edge each time leaves them
   * looking at what they have already judged.
   */
  @action.bound
  reveal(photoId: string): void {
    const cell = this.store.cellOf(photoId);
    if (cell == null) return;
    const centred = this.store.offsetOfCell(cell) - (this.store.viewportLength - this.store.pitch) / 2;
    this.rail.scrollTo(centred);
  }
}

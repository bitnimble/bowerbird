import { action } from 'mobx';
import { adjustOf } from '../../../../../src/schemas/edit_adjust';
import { dustSettings } from '../../../../../src/schemas/dust_settings';
import { describe } from '../../../errors';
import type { Region } from '../edits';
import type { EditStore } from '../edit/edit_store';
import type {
  LocalOpen,
  TileKeep,
} from '../local_decode/local_open';
import type { LocalDecoder } from '../local_decode/local_decoder';
import {
  LOUPE_MAX_MAGNIFICATION,
  LOUPE_MIN_MAGNIFICATION,
  LOUPE_SIZE,
  type LoupeStore,
} from './loupe_store';
import { LoupeTiles, tileFor, type LoupeTile, type TileRect } from './loupe_tiles';
import type { StageStore } from '../stage/stage_store';

/**
 * What one wheel notch multiplies the loupe's magnification by.
 *
 * A quarter more each notch: eight notches to double, which is a comfortable sweep of a wheel
 * for a range that spans four doublings end to end.
 */
const LOUPE_STEP = 1.25;

/**
 * How long the loupe may be still before its tile is asked for.
 *
 * A tile is a tenth of a second of somebody's server, so it is worth rendering for a place the
 * reader has stopped at and not for the ninety they swept through on the way. Longer than the
 * denoise's, because the glass already shows the tick's own render of the same place - waiting
 * costs sharpness the reader has not asked for yet, where waiting on the denoise costs them the
 * answer to the slider they are holding.
 */
export const TILE_QUIET_MS = 200;

interface LoupeSource {
  decoder: LocalDecoder;
  open: LocalOpen;
  photoAnalysis?: number[];
}

interface LoupeHost {
  source(): LoupeSource | null;
  photoId(): string | null;
  closed(): boolean;
  drawable(): boolean;
  handOver(canvas: HTMLCanvasElement): Promise<void>;
  request(region: Region): void;
  clearPending(): void;
  fail(message: string): void;
}

export class LoupePresenter {
  constructor(
    private readonly stage: StageStore,
    private readonly edit: EditStore,
    private readonly store: LoupeStore,
    private readonly host: LoupeHost,
  ) {}

  /**
   * Opens or closes the loupe.
   *
   * Closing forgets where it was, so re-opening it does not flash the magnifier at wherever the
   * pointer happened to leave the stage a minute ago. The magnification survives, being a habit
   * rather than a place.
   */
  @action.bound
  setLoupe(open: boolean): void {
    if (this.store.loupeOpen === open) return;
    this.store.loupeOpen = open;
    if (open) {
      const photoId = this.host.photoId();
      if (photoId != null && this.tiles == null) {
        this.tiles = new LoupeTiles(
          async (rect) => this.renderTile(rect),
          // A tile landing is not a state change anything renders from directly - the glass is
          // a canvas - so this asks for the draw that will put it there.
          () => this.drawLoupe(this.store.loupeBox),
          action((busy: boolean) => {
            this.store.loupeRendering = busy;
          }),
        );
      }
      return;
    }
    this.store.loupeAt = null;
    this.store.loupeSharp = false;
    // A draw and a tile owed to a glass nobody is holding any more.
    this.host.clearPending();
    if (this.tileTimer != null) clearTimeout(this.tileTimer);
    this.tileTimer = null;
    this.tiles?.clear();
    this.holdTile(null);
  }

  /**
   * Where the pointer is over the stage, in its own CSS pixels, or null once it leaves.
   *
   * The region to draw is worked out here rather than passed in: the component knows where the
   * pointer is and this knows what the loupe is for, and putting the arithmetic on the presenter
   * is what lets a test ask "what does the loupe show at this corner" without a browser.
   */
  @action.bound
  moveLoupe(at: { x: number; y: number } | null, box: { width: number; height: number }): void {
    // Held inside the picture, so a drag that runs past the edge parks the glass against it
    // rather than magnifying somewhere the photograph is not.
    // Kept, so a tile arriving later can be drawn against the same box the move used: the
    // fetch answers on its own schedule and nothing there may read layout.
    this.store.loupeBox = box;
    this.store.loupeAt =
      at == null
        ? null
        : {
            x: Math.min(Math.max(at.x, 0), box.width),
            y: Math.min(Math.max(at.y, 0), box.height),
          };
    this.drawLoupe(box);
  }

  /**
   * A wheel notch over the loupe: magnification up or down a step.
   *
   * Geometric rather than linear, because what a reader wants next from 8x is 11x and not 9x -
   * and the same notch has to be worth something at 1x, where linear steps of one would be a
   * doubling.
   */
  @action.bound
  zoomLoupe(notches: number, box: { width: number; height: number }): void {
    this.setLoupeMagnification(this.store.loupeMagnification * Math.pow(LOUPE_STEP, -notches), box);
  }

  /**
   * The magnification itself, for a gesture that names it rather than stepping it.
   *
   * A pinch is a ratio and not a count of notches: the fingers say how much bigger, so what
   * reaches here is the answer rather than a direction.
   */
  @action.bound
  setLoupeMagnification(magnification: number, box: { width: number; height: number }): void {
    this.store.loupeMagnification = Math.min(
      LOUPE_MAX_MAGNIFICATION,
      Math.max(LOUPE_MIN_MAGNIFICATION, magnification),
    );
    this.drawLoupe(box);
  }

  /**
   * The loupe's own draw, at the region under the pointer.
   *
   * `box` is the stage's CSS size, which is what the pointer's position is a fraction of. The
   * region on screen is the store's, so the loupe magnifies whatever the reader is already
   * looking at - a zoomed view included.
   */
  @action.bound
  private drawLoupe(box: { width: number; height: number }): void {
    const at = this.store.loupeAt;
    const region = this.stage.region;
    if (at == null || region == null || !this.host.drawable() || box.width === 0 || box.height === 0) {
      return;
    }
    // Where the pointer is in the frame's own pixels, then a window of the frame around it. The
    // window is the loupe's side divided by the magnification, so a bigger number is fewer
    // source pixels stretched over the same square.
    const centre = {
      x: region.x + (at.x / box.width) * region.width,
      y: region.y + (at.y / box.height) * region.height,
    };
    const span = LOUPE_SIZE / this.store.loupeMagnification;

    // **The editor's own render, always, and the rendition's tile over it when one has
    // arrived.** The tick's denoise is the sRGB one, which is cruder than what an export gets;
    // a loupe is where that difference is worth seeing, so the crop goes through the rendition
    // pipeline. That takes tens of milliseconds at best, which is a seam if the glass waits for
    // it and a sharpening if it does not - so this draws what it can now and the tile takes over
    // when it can.
    const glass = {
      x: centre.x - span / 2,
      y: centre.y - span / 2,
      width: span,
      height: span,
    };

    const frame = { width: this.stage.width, height: this.stage.height };
    const tiles = frame.width === 0 ? null : this.tiles;
    tiles?.invalidate(this.tileRevision());
    const held = tiles?.covering(centre, span, frame) ?? null;
    // A tile is the window the grade reads, so it is drawn *through* the glass's own canvas by
    // the same shaders the frame under it is.
    const origin = this.holdTile(held);
    this.store.loupeSharp = held != null;
    this.host.request(
      origin == null ? glass : { ...glass, x: glass.x - origin.left, y: glass.y - origin.top },
    );
    if (held != null || tiles == null) return;

    // **Nothing is asked for while the pointer is moving.** Aborting the request in flight
    // bounds what the server is working on to one, and does nothing about how many are *asked
    // for*: a sweep from one corner to the other crosses a tile boundary every hundred pixels
    // or so, and each crossing was a request the reader had already left behind by the time it
    // answered. A tile is worth rendering for somewhere they have stopped, so this waits until
    // they have.
    const wanted = tileFor(centre, span, frame);
    if (this.tileTimer != null) clearTimeout(this.tileTimer);
    this.tileTimer = setTimeout(() => {
      this.tileTimer = null;
      this.tiles?.want(wanted);
    }, TILE_QUIET_MS);
  }

  private tileTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Puts a decoded tile on the device, and says where its window sits in the frame.
   *
   * Null for no tile at all, which is a glass drawing the editor's own frame.
   *
   * Uploaded once per tile rather than per move: a pointer sweep inside one tile is dozens of
   * draws from the same buffer.
   */
  private holdTile(held: LoupeTile | null): { left: number; top: number } | null {
    if (held == null) {
      // Swallowed: the decoder refuses what is in flight as it closes, and letting the glass go is
      // exactly what a reader does on the way out.
      if (this.tileOnGpu != null) void this.host.source()?.decoder.releaseTile().catch(() => {});
      this.tileOnGpu = null;
      return null;
    }
    // Already the module's: `LoupeTiles` asks for a tile by building it there, so what is left
    // here is remembering which one, and where its window sits.
    this.tileOnGpu = held;
    const { left, top } = held.keep;
    return { left: held.rect.left - left, top: held.rect.top - top };
  }

  /** Which tile the module is holding, by identity, so a move rebuilds nothing. */
  private tileOnGpu: LoupeTile | null = null;

  /**
   * One tile of the photograph at rendition quality, decoded here.
   *
   * **Pixels rather than a picture.** A tile that never crosses a wire has nothing to encode for:
   * what the glass needs is the window the grade reads, and the page has the module, the RAW and
   * the device to produce it - 35ms against 425ms and no request at all.
   *
   * The frame's own numbers go into the request for the reason `job::Base::build` gives: a crop's
   * own noise fit and diffuse white describe where the reader is pointing rather than the
   * photograph. The scene peak is not among them - the tile is drawn through the same peak buffer
   * the tick measured, which is that same argument answered by construction.
   */
  private async renderTile(rect: TileRect): Promise<TileKeep> {
    const local = this.host.source();
    const doc = this.edit.doc;
    if (local == null) throw new Error('this editor has not opened a RAW to magnify');
    // Nothing to grade a tile with, which is an editor whose document could not be read: it is
    // usable at neutral and the glass keeps showing the tick's own render.
    if (doc == null) throw new Error('there is no document to build a tile against');
    // Built and kept where it will be drawn: the module holds it on its own device, so what
    // comes back is the window's rectangle rather than a few megabytes of samples.
    return local.decoder.holdTile({
      tile: [rect.left, rect.top, rect.width, rect.height],
      frame: [this.stage.width, this.stage.height],
      grade: local.open.grade,
      strengths: { sharpen: doc.sharpening / 100, defringe: local.open.defringe },
      denoiseLuminance: doc.luminanceNoise,
      denoiseColour: doc.colourNoise,
      dust: dustSettings(doc),
      adjust: adjustOf(doc),
      levels: this.stage.levels,
      noiseFit: this.stage.noiseFit,
      defocus: this.stage.defocus,
      photoAnalysis: local.photoAnalysis,
      repairs: doc.repairs,
    });
  }

  /**
   * What the held tiles were built against.
   *
   * A tile is the export's pixels for the reader's *current* settings, so anything that would
   * change one changes every tile at once. The document's revision covers what the server would
   * render - it stamps one on every write - and the fields beside it are what shapes the *window*
   * rather than its grade: the mosaic denoise runs inside the decode, and the presence three
   * decide how far past the rectangle the guided filter has to have read.
   */
  private tileRevision(): string {
    const doc = this.edit.doc;
    // The dust three ride here beside the Detail pair for the same reason: `rev` only moves when a
    // save round-trips, and these change the tile's pixels the moment they are dragged. Without
    // them the magnifier serves a cached tile still carrying a particle the stage has removed.
    const shape =
      doc == null
        ? ''
        : `${doc.luminanceNoise},${doc.colourNoise},${doc.sharpening},${doc.clarity},` +
          `${doc.texture},${doc.dehaze},${doc.dustRemoval},${doc.dustSensitivity},` +
          `${doc.dustIntensity},${JSON.stringify(doc.repairs)}`;
    return `${this.host.photoId()}:${this.edit.rev}:${shape}`;
  }

  /** The tiles for the photo on screen, built with the first loupe that wants one. */
  private tiles: LoupeTiles | null = null;

  /**
   * The loupe's canvas, handed to the worker once React has mounted it.
   *
   * Both arms swallow their own rejection rather than leaving it unhandled: putting the glass down
   * and leaving the photograph is one gesture, and the decoder refuses everything in flight as it
   * closes - so the ordinary way out of the editor would otherwise log a rejection every time.
   */
  @action.bound
  attachLoupe(canvas: HTMLCanvasElement | null): void {
    if (canvas == null) {
      void this.host.source()?.decoder.releaseLoupe().catch(() => {});
      return;
    }
    void this.host.handOver(canvas).catch((error: unknown) => {
      if (!this.host.closed()) this.host.fail(describe(error));
    });
  }

  clearTiles(): void {
    this.tiles?.clear();
  }

  close(): void {
    if (this.tileTimer != null) clearTimeout(this.tileTimer);
    this.tileTimer = null;
    this.tiles?.clear();
    this.tileOnGpu = null;
  }
}

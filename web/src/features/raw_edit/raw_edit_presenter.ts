import { action } from 'mobx';
import { ApiError, api, preparedPath, tilePath, type EditDoc, type EditState } from '../../api/client';
import { send } from '../../api/transport';
import { describe } from '../../errors';
import {
  draggedCrop,
  turnedForDocument,
  turnedPointForDocument,
  type CropGrip,
  type CropRect,
} from './crop_turn';
import { insetCrop } from './crop_to_bounds';
import { LoupeTiles, tileFor, type TileRect } from './loupe_tiles';
import { keystoneFromGuides, type KeystoneGuide } from './keystone';
import {
  EditPipeline,
  type PreparedHeader,
  type Region,
  editCanvasConfiguration,
  stageResolution,
  editFeatures,
  editLimits,
} from './gpu/edit_pipeline';
import { readSetting, writeSetting } from '../../app/local_setting';
import {
  LOUPE_MAX_MAGNIFICATION,
  LOUPE_MIN_MAGNIFICATION,
  LOUPE_SIZE,
  type EditTool,
  type GuideKind,
  type RawEditStore,
  type SaveStatus,
} from './raw_edit_store';

/**
 * What one wheel notch multiplies the loupe's magnification by.
 *
 * A quarter more each notch: eight notches to double, which is a comfortable sweep of a wheel
 * for a range that spans four doublings end to end.
 */
const LOUPE_STEP = 1.25;

/**
 * How long the Detail sliders may be still before the denoise runs.
 *
 * Long enough that a drag is a handful of renders rather than one per position, short enough
 * that a reader who pauses mid-drag sees the answer before they wonder whether it is coming.
 */
const DENOISE_QUIET_MS = 120;

/**
 * How long the loupe may be still before its tile is asked for.
 *
 * A tile is a tenth of a second of somebody's server, so it is worth rendering for a place the
 * reader has stopped at and not for the ninety they swept through on the way. Longer than the
 * denoise's, because the glass already shows the tick's own render of the same place - waiting
 * costs sharpness the reader has not asked for yet, where waiting on the denoise costs them the
 * answer to the slider they are holding.
 */
const TILE_QUIET_MS = 200;

const CROP_TO_FIT_KEY = 'bowerbird.edit.cropToFit';

/**
 * Whether the server refused a write because these edits moved under it.
 *
 * Asked of the status rather than of the message. `describe` returns the server's
 * prose, which says what happened and never says `409`, so matching on the text was
 * reporting every conflict as a generic failure - and telling the reader to retry
 * the one thing that cannot work.
 */
function conflicted(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

/**
 * Drives one RAW through the open-once, grade-per-tick loop.
 *
 * The open happens on the server, natively and on real threads (`edit::prepare`); what
 * crosses is the prepared frame, once. Every slider move after that is a uniform write and
 * a dispatch chain over a buffer that never leaves the GPU, so there is no worker, no
 * `SharedArrayBuffer`, no rayon pool, no encode and no blob (`docs/raw-edit-gpu.md` §6).
 *
 * The drag and the settle are the same call now. `Resolution::Interactive` existed because
 * a CPU tick could not be afforded at full size, and a GPU one can - so the 960px preview,
 * the second `Prepared` and the two entry points all went with it.
 */
export class RawEditPresenter {
  private device: GPUDevice | null = null;
  private pipeline: EditPipeline | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private viewport: ResizeObserver | null = null;
  private density: MediaQueryList | null = null;
  /** The last CSS box the observer reported, so a density change can re-fit against it. */
  private box: { width: number; height: number } | null = null;

  /** The frame the slider is asking for while one is already in flight. */
  private pending: number | null = null;
  private frame = 0;
  private closed = false;

  /** Which photo's edits are being written, kept because `open` is the only caller told. */
  private photoId: string | null = null;
  private saving = false;
  /** A settle that arrived while a save was in flight. Only the latest is ever kept. */
  private pendingSave = false;
  /**
   * Whether the document moved locally since the save in flight was sent.
   *
   * Set by `preview`, so a drag counts and not only a release: without it the
   * server's answer to the *previous* value would overwrite what the reader is
   * currently looking at, and the picture would jump backwards mid-gesture.
   */
  private locallyEdited = false;

  constructor(private readonly store: RawEditStore) {
    // The habit the last session ended on. Read here rather than defaulted in the store,
    // which holds data and does not go and get any.
    store.cropToFit = readSetting(CROP_TO_FIT_KEY) !== '0';
  }

  /**
   * The canvas the tick draws into, once React has mounted it.
   *
   * Configured here rather than in the component because the configuration is the picture:
   * `rgba16float` carries values above SDR white and `toneMapping: extended` is what makes
   * the compositor show them, and both were measured before they were chosen (§7).
   */
  @action.bound
  attach(canvas: HTMLCanvasElement | null): void {
    this.viewport?.disconnect();
    this.viewport = null;
    this.density?.removeEventListener('change', this.onDensity);
    this.density = null;
    this.canvas = canvas;
    if (canvas == null) return;
    // The observer's own box rather than `getBoundingClientRect`: the size arrives with
    // the callback, so nothing on this path reads layout. It also fires once on observe,
    // which is what gives the canvas its first size.
    this.viewport = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box != null) {
        this.box = { width: box.width, height: box.height };
        this.request(this.store.exposureEv);
      }
    });
    this.viewport.observe(canvas);
    this.watchPixelRatio();
  }

  /**
   * The other thing that changes how many device pixels the stage is worth.
   *
   * `devicePixelRatio` is half of `stageResolution`, and dragging the window to a display of
   * a different density moves it without moving the CSS box - so the resize observer never
   * fires and the canvas keeps a backing store sized for the panel it left. On a 2x panel
   * that is a half-resolution photograph, on the way back a wastefully large one, and it
   * lasts until something else resizes the stage.
   *
   * A media query rather than a poll, and re-armed each time because the query names the
   * ratio it was created at.
   */
  private watchPixelRatio(): void {
    this.density?.removeEventListener('change', this.onDensity);
    this.density = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`) ?? null;
    this.density?.addEventListener('change', this.onDensity);
  }

  @action.bound
  private onDensity(): void {
    if (this.closed) return;
    this.watchPixelRatio();
    this.request(this.store.exposureEv);
  }

  /**
   * Sizes the canvas backing store for the viewport and the region about to be drawn.
   *
   * Held to what the frame can actually fill, which is why it needs the region: on a
   * 61MP frame the whole picture is more than any display, and zoomed in far enough it is
   * fewer source pixels than the panel has.
   *
   * **In the frame that draws, and nowhere else.** The shader scales the region onto the
   * canvas axis by axis, so a backing store whose shape disagrees with the region stretches
   * the picture across it - and every write of the region is a new shape: a straighten, a
   * turn, a crop, a step through the history. Sized from a separate effect this was a race
   * against React's, and every frame that won it drew the photograph distorted.
   */
  private sizeStage(): void {
    const canvas = this.canvas;
    const device = this.device;
    const box = this.box;
    const region = this.store.region;
    if (canvas == null || device == null || box == null || region == null) return;
    if (box.width === 0 || box.height === 0) return;

    const size = stageResolution(box, region, device.limits.maxTextureDimension2D);
    if (canvas.width === size.width && canvas.height === size.height) return;
    canvas.width = size.width;
    canvas.height = size.height;
  }

  /**
   * Zoom and pan: the rectangle of the frame on screen, held inside the frame.
   *
   * The region is half of what the stage's resolution is computed from: zoomed in, fewer
   * source pixels have to cover the same box, so the backing store is capped by the region's
   * own resolution rather than the panel's - past 1:1 there is nothing left to resolve and the
   * compositor's upscale is the honest answer. Zoomed back out it has to grow again. Which is
   * `sizeStage`'s, on the frame this asks for.
   */
  @action.bound
  showRegion(region: Region): void {
    // Held to the *picture*, not the frame: with a crop the two are different sizes, and a
    // region clamped to the frame would let a zoomed-out view sit outside what is drawn.
    const picture = this.store.output;
    const width = Math.min(Math.max(region.width, 1), picture.width);
    const height = Math.min(Math.max(region.height, 1), picture.height);
    const next = {
      width,
      height,
      x: Math.min(Math.max(region.x, 0), picture.width - width),
      y: Math.min(Math.max(region.y, 0), picture.height - height),
    };
    const held = this.store.region;
    if (
      held != null &&
      held.x === next.x &&
      held.y === next.y &&
      held.width === next.width &&
      held.height === next.height
    ) {
      return;
    }
    this.store.region = next;
    this.request(this.store.exposureEv);
  }

  /**
   * Opens the RAW behind `photoId` and grades it at `longEdge` pixels on its long edge.
   *
   * Never rejects: both callers fire this and forget it, so anything escaping would leave
   * the page at "loading" with no reason given.
   */
  async open(photoId: string, longEdge: number): Promise<void> {
    this.begin();
    this.photoId = photoId;
    // Started here and awaited below, so the decode and the settings load overlap:
    // the open is seconds of LibRaw and this is one small row.
    const edits = api.getEdits(photoId).catch(() => null);
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter == null) {
        this.fail('this browser has no WebGPU, which the editor now needs');
        return;
      }
      // Before the device rather than after it, so a failure below is reported against the
      // GPU that refused rather than against no GPU at all.
      this.describeAdapter(adapter);
      const device = await adapter.requestDevice({
        requiredFeatures: editFeatures(adapter),
        requiredLimits: editLimits(adapter),
      });
      // Destroyed here rather than left to `close`, which has already run and found no
      // device to take: leaving it would hold the adapter for the life of the page.
      if (this.closed) {
        device.destroy();
        return;
      }
      this.device = device;
      device.lost.then((reason) => {
        if (!this.closed && reason.reason !== 'destroyed') this.fail(`the GPU device was lost: ${reason.message}`);
      });
      // The failure mode this whole path is written around. A validation error is
      // asynchronous and rejects nothing: the offending call returns, the dispatch is
      // dropped, the reader is told `live`, and the canvas stays black with nothing anywhere
      // saying why. Reported here so the next one names itself.
      device.onuncapturederror = (event) => {
        if (!this.closed) this.fail(`the GPU refused a command: ${event.error.message}`);
      };

      this.preparing();
      const { header, samples } = await fetchPrepared(photoId, longEdge);
      if (this.closed) return;

      const canvas = this.canvas;
      if (canvas == null) {
        this.fail('the stage was not mounted before the RAW arrived');
        return;
      }
      const context = canvas.getContext('webgpu');
      if (context == null) {
        this.fail('this browser has no WebGPU canvas context');
        return;
      }
      // Everything the open builds on the device, under one scope: a texture, a layout or a
      // pipeline the GPU will not have is a validation error rather than an exception, and
      // the open is the one place that can still say so before the reader is told `live`.
      device.pushErrorScope('validation');
      context.configure(editCanvasConfiguration(device));

      this.pipeline = new EditPipeline(device, context, header, samples);
      const refused = await device.popErrorScope();
      if (this.closed) return;
      if (refused != null) {
        // Dropped here rather than left to `close`: what it holds is the frame, which at
        // 61MP is 361MB of GPU memory for a tick that will never run.
        this.pipeline?.destroy();
        this.pipeline = null;
        this.fail(`this GPU refused the tick: ${refused.message}`);
        return;
      }
      this.opened(header);
      // Re-attached rather than left as it was: the observer needs a region and a device
      // to size against, and neither existed when React handed the element over.
      this.attach(canvas);

      // After `opened`, which sets the neutral state, so a saved exposure lands on
      // top of a live pipeline and draws. A read that failed leaves the editor
      // usable at neutral rather than refusing to open: the frame is the expensive
      // part and it is already here.
      const saved = await edits;
      if (this.closed) return;
      if (saved != null) this.applyState(saved);
      // Through `preview` rather than `request` alone: the pipeline holds the sliders
      // separately from the tick's exposure, so a document has to reach both or the frame
      // opens graded by the exposure and nothing else. That now includes the denoise, which
      // is a chain of passes rather than a uniform word. A read that failed leaves `doc`
      // null and `preview` returns on it, which is the editor usable at neutral.
      this.preview({});
    } catch (error) {
      if (!this.closed) this.fail(describe(error));
    }
  }

  /**
   * The exposure the slider is at, while it moves.
   *
   * Local only. A pointer emits far more positions than anything should be asked to
   * store, and the undo stack would be four hundred entries for one drag.
   */
  @action.bound
  previewExposure(ev: number): void {
    this.preview({ exposure: ev });
  }

  /** Any parameter, while its control moves. The exposure is the one with a shader behind it today. */
  @action.bound
  preview(patch: Partial<EditDoc>): void {
    const doc = this.store.doc;
    if (doc == null) return;
    const next = { ...doc, ...patch };
    this.store.doc = next;
    this.locallyEdited = true;
    // The geometry before the grade, because it decides what the draw is even reading. The
    // store works out whether the crop tool wants it whole (`store.geometry`).
    this.followGeometry();
    // Everything but the exposure, which the tick carries as a gain. Pushed on every
    // move rather than on release so a drag shows what it is doing.
    this.pipeline?.setAdjust({
      contrast: next.contrast,
      highlights: next.highlights,
      shadows: next.shadows,
      whites: next.whites,
      blacks: next.blacks,
      vibrance: next.vibrance,
      saturation: next.saturation,
      texture: next.texture,
      clarity: next.clarity,
      dehaze: next.dehaze,
      temperature: next.temperature,
      tint: next.tint,
    });
    // Not part of the uniform, and not per move. Every other control reaches the picture
    // through `setAdjust` above and costs nothing; this one is eight dispatches over the whole
    // frame and a rebuild of the blur the presence sliders read, which at 24MP is far more than
    // a pointer emits positions for.
    this.wantDenoise({ luminance: next.luminanceNoise, colour: next.colourNoise });
    this.request(this.store.exposureEv);
  }

  /**
   * Opens and closes the crop tool.
   *
   * The stage shows the frame uncropped while it is open, so leaving it is what makes the crop
   * take visible effect. Refitting the view to the picture that just changed shape is the
   * stage's, not this: the region follows the view.
   */
  @action.bound
  setCropping(open: boolean): void {
    if (this.store.cropping === open) return;
    this.store.cropping = open;
    // One tool at a time. Both open at once shows the frame with the crop *and* the straighten
    // taken off, which is the keystone's stage - and the crop rectangle laid out on it would
    // then be fractions of a different picture from the one it is being dragged over.
    if (open) this.store.keystoning = false;
    this.showGeometry();
  }

  /**
   * A drag of the rectangle, from where it stood when the gesture began.
   *
   * The overlay says which grip and how far the pointer went as a share of the picture; what
   * that does to four edges is `draggedCrop`. Settling on release writes one history entry for
   * the drag, which is the seam every slider commits on.
   */
  @action.bound
  dragCrop(from: CropRect, grip: CropGrip | null, by: { x: number; y: number }, settle: boolean): void {
    this.previewCrop(draggedCrop(from, grip, by));
    if (settle) void this.commit();
  }

  /** The crop rectangle, as fractions of the straightened frame the tool is showing. */
  @action.bound
  previewCrop(rect: CropRect): void {
    const doc = this.store.doc;
    if (doc == null) return;
    // Undoing the turn the overlay laid itself out under (`store.cropRect` does the forward
    // half), so the document keeps the fractions in the order Camera Raw defines them.
    const crop = turnedForDocument(rect, doc.rotate);
    this.preview({
      cropLeft: crop.left,
      cropTop: crop.top,
      cropRight: crop.right,
      cropBottom: crop.bottom,
    });
  }

  @action.bound
  settleCrop(rect: CropRect): void {
    this.previewCrop(rect);
    void this.commit();
  }

  /** A quarter turn, in the direction the button points. */
  @action.bound
  turn(by: 90 | -90): void {
    const doc = this.store.doc;
    if (doc == null) return;
    const rotate = (((doc.rotate + by) % 360) + 360) % 360;
    this.preview({ rotate: rotate as 0 | 90 | 180 | 270 });
    void this.commit();
  }

  /**
   * The header's tool selector, which is the two modes and the absence of both.
   *
   * Each setter already closes the other, so the order here only decides which of them does
   * the closing; both arms end at `showGeometry`, so the stage is drawn for whichever won.
   */
  @action.bound
  setTool(tool: EditTool): void {
    this.setCropping(tool === 'crop');
    this.setKeystoning(tool === 'perspective');
    this.setLoupe(tool === 'loupe');
  }

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
      const photoId = this.photoId;
      if (photoId != null && this.tiles == null) {
        this.tiles = new LoupeTiles(
          photoId,
          fetchTile,
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
    this.store.loupeTile = null;
    // A tile owed to a glass nobody is holding any more.
    if (this.tileTimer != null) clearTimeout(this.tileTimer);
    this.tileTimer = null;
    this.tiles?.clear();
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
  private drawLoupe(box: { width: number; height: number }): void {
    const at = this.store.loupeAt;
    const region = this.store.region;
    const pipeline = this.pipeline;
    if (at == null || region == null || pipeline == null || box.width === 0 || box.height === 0) {
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
    // a loupe is where that difference is worth seeing, so the server renders the crop through
    // the rendition pipeline. That takes about a tenth of a second, which is a seam if the
    // glass waits for it and a sharpening if it does not - so this draws what it can now and
    // the tile lands on top when it can.
    pipeline.renderLoupe(this.store.exposureEv, {
      x: centre.x - span / 2,
      y: centre.y - span / 2,
      width: span,
      height: span,
    });

    const frame = { width: this.store.width, height: this.store.height };
    const tiles = this.tiles;
    if (tiles == null || frame.width === 0) return;
    tiles.invalidate(this.tileRevision());
    const held = tiles.covering(centre, span, frame);
    if (held != null) {
      this.store.loupeTile = { tile: held, centre, span };
      return;
    }
    this.store.loupeTile = null;

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
   * What the held tiles were rendered against.
   *
   * A tile is the export's pixels for the reader's *current* settings, so anything that would
   * change an export changes every tile at once. The document's revision is exactly that - the
   * server stamps it on every write - so one string answers for all of it.
   */
  private tileRevision(): string {
    return `${this.photoId}:${this.store.rev}`;
  }

  /** The tiles for the photo on screen, built with the first loupe that wants one. */
  private tiles: LoupeTiles | null = null;

  /** The loupe's canvas, handed over once React has mounted it. */
  @action.bound
  attachLoupe(canvas: HTMLCanvasElement | null): void {
    this.pipeline?.attachLoupe(canvas);
  }

  /**
   * A change of geometry, with the crop moved onto what it leaves showing.
   *
   * A straighten and a perspective correction both leave the picture sitting in its frame as a
   * quadrilateral with wedges of blank around it, and nobody levels a horizon in order to look
   * at those - so the crop becomes the largest rectangle inside the picture, and the whole
   * frame again where the geometry is back to nothing. One patch rather than two writes: two
   * would be two entries in the history and a frame drawn between them showing the wedges.
   *
   * **Never while the crop tool is open**, whatever the toggle says. There the reader is
   * choosing the rectangle by hand, and replacing it under them mid-gesture is the one thing
   * that must not happen.
   */
  @action.bound
  private fitted(patch: Partial<EditDoc>): Partial<EditDoc> {
    const doc = this.store.doc;
    if (doc == null || !this.store.cropToFit || this.store.cropping) return patch;
    const next = { ...doc, ...patch };
    const rect = insetCrop({
      width: this.store.width,
      height: this.store.height,
      cropAngle: next.cropAngle,
      keystone: next.keystone,
    }) ?? { left: 0, top: 0, right: 1, bottom: 1 };
    return {
      ...patch,
      cropLeft: rect.left,
      cropTop: rect.top,
      cropRight: rect.right,
      cropBottom: rect.bottom,
    };
  }

  /**
   * Whether a geometry change takes the crop with it, and the crop caught up on the way in.
   *
   * Remembered across sessions rather than per photograph: it describes how the reader works,
   * not what this frame is. Settled rather than previewed when it turns on, so the trim it
   * performs is one step in the history like any other.
   */
  @action.bound
  setCropToFit(on: boolean): void {
    this.store.cropToFit = on;
    writeSetting(CROP_TO_FIT_KEY, on ? '1' : '0');
    if (on) this.settle(this.fitted({}));
  }

  @action.bound
  previewStraighten(degrees: number): void {
    this.store.straightening = true;
    this.preview(this.fitted({ cropAngle: Math.round(degrees * 100) / 100 }));
  }

  @action.bound
  settleStraighten(degrees: number): void {
    this.previewStraighten(degrees);
    // The grid is for the gesture, so it goes when the gesture does.
    this.store.straightening = false;
    void this.commit();
  }

  /**
   * Opens and closes the keystone tool.
   *
   * Closing is what makes the correction take effect on screen, because the stage shows the
   * frame uncorrected while the guides are being drawn on it - the same shape the crop tool has,
   * and for the same reason: you cannot line a guide up with an edge that has already been
   * straightened.
   */
  @action.bound
  setKeystoning(open: boolean): void {
    if (this.store.keystoning === open) return;
    this.store.keystoning = open;
    if (open) this.store.cropping = false;
    this.showGeometry();
  }

  /**
   * The picture the region was last measured against, so a change of shape can be noticed.
   *
   * Not the region itself: a zoom moves the region within a picture that has not changed, and
   * that is not what this is about.
   */
  private shown = { width: 0, height: 0 };

  /**
   * The geometry into the pipeline, and the region kept on the picture it now describes.
   *
   * **A region is in the *picture's* pixels, so a straighten invalidates it.** Every move of
   * that slider grows the frame to a new bounding box, and the draw asked for on the next
   * animation frame was reading a window measured against the last one - a sub-rectangle of a
   * bigger picture, which is a clipped, zoomed-in frame. The stage does refit, but through a
   * passive effect that React runs *after* the paint, so what the reader saw was the broken
   * frame and the right one alternating for the length of the drag.
   *
   * Only when the shape actually moves. A slider that leaves the picture the size it was - the
   * exposure, the tone, the colour - must not have the reader's zoom reset under it.
   */
  @action.bound
  private followGeometry(): void {
    this.pipeline?.setGeometry(this.store.geometry);
    const { width, height } = this.store.output;
    if (width === this.shown.width && height === this.shown.height) return;
    this.shown = { width, height };
    // The whole of it, which is what the stage's own refit settles on: it resets the view
    // whenever the shape changes, and `showRegion` returns early on a region it agrees with.
    this.store.region = { x: 0, y: 0, width, height };
  }

  /**
   * What a tool opening or closing does to the picture: a different geometry, drawn.
   *
   * **The draw is the half that is easy to forget.** `setGeometry` is a setter, and the stage
   * only redraws when the *shape* changes - which a crop does and a perspective correction, by
   * design, does not. Closing the tool left the corrected picture unrendered until an unrelated
   * slider happened to push a frame through.
   */
  @action.bound
  private showGeometry(): void {
    this.followGeometry();
    this.request(this.store.exposureEv);
  }

  /**
   * The guides, as the overlay holds them: in the frame the reader is looking at.
   *
   * Turned back into the frame's own fractions on the way in, and the correction recomputed from
   * them here rather than anywhere else. **The matrix is derived once, on the writer's side**,
   * so the document carries an answer both renderers read rather than a question each of them
   * answers - which is the difference between a preview and a rendition agreeing by design and
   * agreeing by luck.
   */
  @action.bound
  setGuides(guides: readonly KeystoneGuide[], settle: boolean): void {
    const doc = this.store.doc;
    if (doc == null) return;
    const stored = guides.map((guide) => {
      const from = turnedPointForDocument({ x: guide.x1, y: guide.y1 }, doc.rotate);
      const to = turnedPointForDocument({ x: guide.x2, y: guide.y2 }, doc.rotate);
      return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
    });
    this.preview(
      this.fitted({
        keystoneGuides: stored,
        keystone: keystoneFromGuides(stored, { width: this.store.width, height: this.store.height }),
      }),
    );
    if (settle) void this.commit();
  }

  /** Which pair the next line drawn on the picture belongs to. */
  @action.bound
  setGuideKind(kind: GuideKind): void {
    this.store.guideKind = kind;
  }

  /** One guide, by the index the overlay and the panel both name it with. */
  @action.bound
  removeGuide(index: number): void {
    this.setGuides(
      this.store.guides.filter((_, at) => at !== index),
      true,
    );
  }

  /** Takes the correction off, guides and all, which is what a reader means by starting again. */
  @action.bound
  clearKeystone(): void {
    this.preview(this.fitted({ keystone: null, keystoneGuides: [] }));
    void this.commit();
  }

  /**
   * The white balance pair, which moves as a pair whichever slider the reader has hold of.
   *
   * Both halves are written even when one moved, and that is the point. The document stores
   * null for "as shot" and the shader reads a missing half as the frame's own - so a
   * temperature written beside a null tint would say "this Kelvin, and whatever tint the
   * camera chose", which is not a rebalance anyone asked for and would drift again on the next
   * photo the settings were pasted onto.
   */
  @action.bound
  previewBalance(patch: { temperature?: number; tint?: number }): void {
    const balance = this.store.balance;
    if (balance == null) return;
    this.preview({
      // Camera Raw's own name for a pair somebody moved, and the document's rather than the
      // panel's to hold: an XMP written from this later has to say what the mode *is*, and a
      // mode derived at the point of display would not be in it.
      whiteBalanceMode: 'Custom',
      temperature: Math.round(patch.temperature ?? balance.temperature),
      tint: Math.round(patch.tint ?? balance.tint),
    });
  }

  @action.bound
  settleBalance(patch: { temperature?: number; tint?: number }): void {
    this.previewBalance(patch);
    void this.commit();
  }

  /**
   * The control was released: the frame that gets judged, and the one worth storing.
   *
   * This is the commit seam. A drag is one history entry because only this end of it
   * reaches the server.
   */
  @action.bound
  settleExposure(ev: number): void {
    this.preview({ exposure: ev });
    void this.commit();
  }

  /** As above, for a control that is not the exposure slider. */
  @action.bound
  settle(patch: Partial<EditDoc>): void {
    this.preview(patch);
    // The drag is over, so whatever the denoise still owes is owed now rather than in a tenth
    // of a second: a reader who has let go is looking at the picture.
    this.flushDenoise();
    void this.commit();
  }

  /**
   * Asks for a denoise, once the slider has stopped moving.
   *
   * **The picture lags the slider here, on purpose.** The chain is eight dispatches over the
   * whole frame and takes the detail blur with it, where every other control is a word in a
   * uniform - so running it per pointer position spends the whole frame budget on a picture
   * that is replaced before it is looked at, and the control itself goes sticky under the hand.
   * A short quiet period turns a drag into a handful of renders, and the release settles it.
   */
  @action.bound
  private wantDenoise(next: { luminance: number; colour: number }): void {
    if (this.denoiseWanted?.luminance === next.luminance && this.denoiseWanted.colour === next.colour) {
      return;
    }
    this.denoiseWanted = next;
    if (this.denoiseTimer != null) clearTimeout(this.denoiseTimer);
    this.denoiseTimer = setTimeout(() => this.flushDenoise(), DENOISE_QUIET_MS);
  }

  /** Runs whatever the sliders last asked for, now. */
  private flushDenoise(): void {
    if (this.denoiseTimer != null) {
      clearTimeout(this.denoiseTimer);
      this.denoiseTimer = null;
    }
    const wanted = this.denoiseWanted;
    if (wanted == null) return;
    this.denoiseWanted = null;
    this.pipeline?.setDenoise(wanted);
    this.request(this.store.exposureEv);
  }

  private denoiseWanted: { luminance: number; colour: number } | null = null;
  private denoiseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Sends the document, one save at a time, coalescing whatever arrived meanwhile.
   *
   * Serialised rather than fired per settle, because two saves in flight can land
   * out of order: the server diffs against whatever arrived last, so the stored
   * document would be the *earlier* value and the history would record a step in
   * the wrong direction. Same shape as `request`'s frame coalescing, and for the
   * same reason - only the latest is ever outstanding.
   */
  private async commit(): Promise<void> {
    if (this.saving) {
      this.pendingSave = true;
      return;
    }
    const photoId = this.photoId;
    const doc = this.store.doc;
    if (photoId == null || doc == null) return;

    this.saving = true;
    this.locallyEdited = false;
    this.saveStatus('saving');
    try {
      const state = await api.saveEdits(photoId, doc, this.store.rev);
      // The bookkeeping always, the document only if nothing moved while this was
      // in flight. Taking it unconditionally would overwrite a slider the reader
      // moved during the round trip with the value that round trip was about.
      this.applyState(state, this.locallyEdited);
    } catch (error) {
      // A refused revision is not a failure to retry as-is: something else moved
      // these edits, so the client has to take what is there now. Reported rather
      // than resolved - silently reloading would discard what the reader just did.
      this.saveStatus(conflicted(error) ? 'conflict' : 'failed');
    } finally {
      this.saving = false;
      if (this.pendingSave && !this.closed) {
        this.pendingSave = false;
        void this.commit();
      }
    }
  }

  @action.bound
  async undo(): Promise<void> {
    await this.step((photoId, rev) => api.undoEdits(photoId, rev), this.store.canUndo);
  }

  @action.bound
  async redo(): Promise<void> {
    await this.step((photoId, rev) => api.redoEdits(photoId, rev), this.store.canRedo);
  }

  private async step(
    call: (photoId: string, rev: number) => Promise<EditState>,
    allowed: boolean,
  ): Promise<void> {
    const photoId = this.photoId;
    // Waiting rather than racing: a step taken while a save is in flight would be
    // built on a revision the save is about to move.
    if (!allowed || photoId == null || this.saving) return;
    this.saving = true;
    try {
      // A step replaces the document by definition, so it takes the whole answer.
      this.applyState(await call(photoId, this.store.rev));
      this.locallyEdited = false;
      this.request(this.store.exposureEv);
    } catch (error) {
      this.saveStatus(conflicted(error) ? 'conflict' : 'failed');
    } finally {
      this.saving = false;
      // A settle that arrived mid-step took `commit`'s "already saving" arm and left this set.
      // Only `commit` drains it, so without this the document waits for some later save to
      // notice - and that save then sends a second one nobody asked for.
      if (this.pendingSave) {
        this.pendingSave = false;
        void this.commit();
      }
    }
  }

  /**
   * The server's answer, which is authoritative for the revision and both flags.
   *
   * `keepDoc` leaves the document alone, for the one case where the server's copy
   * is already out of date on arrival: a save that the reader edited on top of
   * while it was in flight.
   */
  @action.bound
  private applyState(state: EditState, keepDoc = false): void {
    if (this.closed) return;
    if (!keepDoc) {
      this.store.doc = state.doc;
      // An undo can move the crop, and the draw has to follow it rather than keep showing
      // the shape the reader has just stepped away from - region and all, or the frame after
      // the step is a window measured against the picture before it.
      this.followGeometry();
    }
    this.store.rev = state.rev;
    this.store.canUndo = state.canUndo;
    this.store.canRedo = state.canRedo;
    this.store.saveStatus = 'clean';
  }

  @action.bound
  private saveStatus(status: SaveStatus): void {
    if (!this.closed) this.store.saveStatus = status;
  }

  close(): void {
    if (this.closed) return;
    // A denoise owed to a slider nobody is holding any more, on a pipeline about to be
    // destroyed: cancelled rather than flushed.
    if (this.denoiseTimer != null) clearTimeout(this.denoiseTimer);
    this.denoiseTimer = null;
    this.denoiseWanted = null;
    if (this.tileTimer != null) clearTimeout(this.tileTimer);
    this.tileTimer = null;
    this.tiles?.clear();
    // Before the flag, and only where something was actually stored: this is what asks
    // the server to build the picture the reader ended up with. No write above rebuilds
    // anything, because a slider release says nothing about whether they are finished -
    // so leaving without this is leaving the rendition at the last render.
    //
    // Fire-and-forget, and the server does not depend on it arriving: the rebuild is
    // queued off the edits being newer than the render, so a tab closed before this
    // lands is caught by the sweep at startup instead.
    const photoId = this.photoId;
    if (photoId != null && this.store.rev > 0) {
      void api.finishEdits(photoId).catch(() => {});
    }

    this.closed = true;
    this.viewport?.disconnect();
    this.viewport = null;
    this.density?.removeEventListener('change', this.onDensity);
    this.density = null;
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.pipeline?.destroy();
    this.pipeline = null;
    this.device?.destroy();
    this.device = null;
  }

  /**
   * Coalesced onto the next frame, not queued.
   *
   * A pointer emits far more positions than a display can show, and queueing them would
   * replay the drag in slow motion after the user let go. Only the latest is ever
   * outstanding.
   *
   * Everything that changes what is on screen ends here, the stage's own size included, so
   * the whole state a frame is drawn from is read in one breath immediately before drawing it.
   */
  private request(ev: number): void {
    if (this.closed || this.pipeline == null) return;
    this.pending = ev;
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const next = this.pending;
      this.pending = null;
      if (next == null || this.closed || this.pipeline == null) return;
      this.sizeStage();
      this.pipeline.render(next, this.store.region ?? this.pipeline.wholeFrame);
    });
  }

  @action.bound
  private describeAdapter(adapter: GPUAdapter): void {
    const info = adapter.info as { vendor?: string; architecture?: string; device?: string } | undefined;
    this.store.adapter =
      [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(' / ') || 'unreported';
  }

  @action.bound
  private begin(): void {
    this.store.status = 'fetching';
    this.store.message = 'asking the server for the frame';
    this.store.width = 0;
    this.store.height = 0;
    // The exposure is derived from the document now, so clearing it is clearing
    // that: a stale one would draw the previous photo's grade over this one's
    // frame for as long as the read takes.
    this.store.doc = null;
    this.store.rev = 0;
    this.store.canUndo = false;
    this.store.canRedo = false;
    this.store.saveStatus = 'clean';
    this.store.matched = false;
    this.store.asShot = null;
  }

  @action.bound
  private preparing(): void {
    this.store.status = 'preparing';
    this.store.message = 'decoding, fitting the camera match and warping';
  }

  @action.bound
  private opened(header: PreparedHeader): void {
    this.store.status = 'live';
    this.store.message = '';
    this.store.width = header.width;
    this.store.height = header.height;
    this.store.matched = header.matched;
    this.store.asShot = header.asShot;
    // Whatever the document already says - an imported sidecar routinely arrives cropped - so
    // the first frame drawn is the picture rather than the frame it was taken out of. The frame
    // has only just arrived, so this is the first shape there has been and it seeds the region.
    this.shown = { width: 0, height: 0 };
    this.followGeometry();
  }

  @action.bound
  /**
   * The first failure wins, not the last.
   *
   * A GPU validation error cascades: the offending call is dropped, the encoder it was
   * recorded into is poisoned, and the submit that follows reports "invalid due to a
   * previous error" - which is what a reader and a stack trace both end up looking at. The
   * one that says what actually happened is the first.
   */
  private fail(message: string): void {
    if (this.store.status === 'failed') return;
    this.store.status = 'failed';
    this.store.message = message;
  }
}

/**
 * The prepared frame, header and all, over whichever transport is running.
 *
 * A `u32` length, that much JSON, then the samples - one framing for both transports, and
 * in the body rather than in an `X-Prepared` response header because a matched frame's
 * description is 11KB and a reverse proxy answers 502 rather than forward a header that
 * size.
 *
 * A view over those bytes rather than a copy of them. Both transports pad the JSON to four
 * for exactly this reason, so at 61MP the open holds one 361MB array rather than three.
 */
/**
 * One loupe tile, as a blob the browser can decode.
 *
 * Over the same transport everything else uses, so the desktop shell's IPC answers it too - the
 * loupe is not a browser feature and the bytes are JPEG either way.
 */
async function fetchTile(photoId: string, rect: TileRect, signal: AbortSignal): Promise<Blob> {
  const reply = await send('get:tile', 'GET', tilePath(photoId, rect), undefined, signal);
  if (reply.status < 200 || reply.status >= 300) {
    throw new Error(`could not render that tile: ${reply.status}`);
  }
  return new Blob([reply.bytes as BlobPart], { type: 'image/jpeg' });
}

async function fetchPrepared(
  photoId: string,
  longEdge: number,
): Promise<{ header: PreparedHeader; samples: Uint16Array<ArrayBuffer> }> {
  const path = preparedPath(photoId, longEdge);
  const reply = await send('get:prepared', 'GET', path);
  if (reply.status < 200 || reply.status >= 300) {
    const detail = new TextDecoder().decode(reply.bytes).slice(0, 200);
    throw new Error(`could not open this RAW: ${reply.status} ${detail}`);
  }

  const { buffer, byteOffset, byteLength } = reply.bytes;
  if (byteLength < 4) throw new Error('the prepared frame arrived with no header');
  const described = new DataView(buffer, byteOffset, byteLength).getUint32(0, true);
  if (described + 4 > byteLength) throw new Error('the prepared frame arrived truncated');

  return {
    header: JSON.parse(
      new TextDecoder().decode(reply.bytes.subarray(4, 4 + described)),
    ) as PreparedHeader,
    samples: new Uint16Array(
      buffer,
      byteOffset + 4 + described,
      (byteLength - 4 - described) >> 1,
    ),
  };
}

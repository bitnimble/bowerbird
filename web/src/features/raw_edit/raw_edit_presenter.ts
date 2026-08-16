import { action } from 'mobx';
import {
  ApiError,
  api,
  cameraMatchUrl,
  downloadUrl,
  type EditDoc,
  type EditState,
} from '../../api/client';
import { describe } from '../../errors';
import {
  draggedCrop,
  turnedForDocument,
  turnedPointForDocument,
  type CropGrip,
  type CropRect,
} from './crop_turn';
import { insetCrop } from './crop_to_bounds';
import { LoupeTiles, tileFor, type LoupeTile, type TileRect } from './loupe_tiles';
import type { LocalDecoder, LocalOpen, LocalTile } from './local_open';
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
export const TILE_QUIET_MS = 200;

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
 * The rectangle a fit is taken out of: what the reader framed, or the crop where nothing has
 * been fitted yet.
 *
 * The fallback is what makes an imported sidecar behave. It arrives cropped and with no framing
 * stored, and that rectangle is the reader's own rather than the output of any fit - so
 * levelling its horizon trims the wedges out of it instead of handing back the frame they had
 * already cropped away.
 */
function framedIn(doc: EditDoc): CropRect {
  const { framedLeft, framedTop, framedRight, framedBottom } = doc;
  if (framedLeft == null || framedTop == null || framedRight == null || framedBottom == null) {
    return { left: doc.cropLeft, top: doc.cropTop, right: doc.cropRight, bottom: doc.cropBottom };
  }
  return { left: framedLeft, top: framedTop, right: framedRight, bottom: framedBottom };
}

/**
 * Drives one RAW through the open-once, grade-per-tick loop.
 *
 * The open happens in this tab where it can (`fetchPrepared`) and on the server where it
 * cannot; either way it happens once. Every slider move after that is a uniform write and
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
    // Awaited before the decode rather than alongside it, which it used to be. The open denoises
    // the mosaic at this document's Detail, so the document is now an input to the decode rather
    // than something applied to a frame that is already prepared - one small row ahead of seconds
    // of LibRaw.
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
      const saved = await edits;
      if (this.closed) return;
      const { header, samples, local } = await fetchPrepared(photoId, longEdge, {
        luminance: saved?.doc.luminanceNoise ?? 0,
        colour: saved?.doc.colourNoise ?? 0,
      });
      if (this.closed) {
        // Closed here rather than left to `close`, which has already run and found no decoder
        // to take: leaving it would hold a thread and this photograph's RAW for the life of the page.
        local.decoder.close();
        return;
      }
      this.local = local;

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
    // A hand on the rectangle is the only thing that says what the reader wants kept, so it
    // replaces what a later straighten trims out of - and the crop tool draws on the frame
    // uncropped, so what they chose is what they get rather than a fit of it.
    this.preview({
      framedLeft: crop.left,
      framedTop: crop.top,
      framedRight: crop.right,
      framedBottom: crop.bottom,
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
    this.pendingLoupe = null;
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

    const frame = { width: this.store.width, height: this.store.height };
    const tiles = frame.width === 0 ? null : this.tiles;
    tiles?.invalidate(this.tileRevision());
    const held = tiles?.covering(centre, span, frame) ?? null;
    // A tile is the window the grade reads, so it is drawn *through* the glass's own canvas by
    // the same shaders the frame under it is.
    const origin = this.holdTile(held);
    this.store.loupeSharp = held != null;
    this.requestLoupe(
      origin == null
        ? glass
        : { ...glass, x: glass.x - origin.left, y: glass.y - origin.top },
      origin != null,
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
      if (this.tileOnGpu != null) this.pipeline?.holdTile(null);
      this.tileOnGpu = null;
      return null;
    }
    if (this.tileOnGpu !== held) {
      this.pipeline?.holdTile(held.tile);
      this.tileOnGpu = held;
    }
    // The window's own origin, which is the rectangle asked for less the margin grown around it.
    const [left, top] = held.tile.keep;
    return { left: held.rect.left - left, top: held.rect.top - top };
  }

  /** Which tile the pipeline is holding, by identity, so a move re-uploads nothing. */
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
  private async renderTile(rect: TileRect): Promise<LocalTile> {
    const local = this.local;
    const doc = this.store.doc;
    if (local == null) throw new Error('this editor has not opened a RAW to magnify');
    // Nothing to grade a tile with, which is an editor whose document could not be read: it is
    // usable at neutral and the glass keeps showing the tick's own render.
    if (doc == null) throw new Error('there is no document to build a tile against');
    return local.decoder.tile({
      tile: [rect.left, rect.top, rect.width, rect.height],
      frame: [this.store.width, this.store.height],
      grade: local.open.grade,
      strengths: local.open.strengths,
      denoiseLuminance: doc.luminanceNoise,
      denoiseColour: doc.colourNoise,
      adjust: {
        contrast: doc.contrast,
        highlights: doc.highlights,
        shadows: doc.shadows,
        whites: doc.whites,
        blacks: doc.blacks,
        vibrance: doc.vibrance,
        saturation: doc.saturation,
        texture: doc.texture,
        clarity: doc.clarity,
        dehaze: doc.dehaze,
        temperature: doc.temperature,
        tint: doc.tint,
      },
      levels: this.store.levels,
      noiseFit: this.store.noiseFit,
      cameraMatch: local.open.cameraMatch,
    });
  }

  /** What this tab opens and magnifies from, until it has opened one. */
  private local: LocalSource | null = null;

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
    const doc = this.store.doc;
    const shape =
      doc == null
        ? ''
        : `${doc.luminanceNoise},${doc.colourNoise},${doc.clarity},${doc.texture},${doc.dehaze}`;
    return `${this.photoId}:${this.store.rev}:${shape}`;
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
    const within = framedIn(next);
    const rect =
      insetCrop({
        width: this.store.width,
        height: this.store.height,
        cropAngle: next.cropAngle,
        keystone: next.keystone,
        within,
      }) ?? within;
    return {
      ...patch,
      // Written on every fit, not only the first. The fit is what makes the pair meaningful -
      // before it there is one rectangle and after it two - and writing the input beside the
      // output in the same patch is what keeps them one step in the history rather than two.
      framedLeft: within.left,
      framedTop: within.top,
      framedRight: within.right,
      framedBottom: within.bottom,
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
    // The thread the tiles were decoded on, holding the RAW and the module's heap.
    this.local?.decoder.close();
    this.local = null;
    this.tileOnGpu = null;
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
    this.pump();
  }

  /**
   * The same, for the glass: the window it should magnify next.
   *
   * Through the same loop rather than drawn where the pointer move is handled. A move emits
   * far more positions than a display can show and each one was a submit, on a swapchain that
   * blocks exactly like the stage's - so the glass paid the cost the sliders were paying, on
   * the one gesture that emits fastest.
   */
  private requestLoupe(region: Region, fromTile = false): void {
    if (this.closed || this.pipeline == null) return;
    this.pendingLoupe = { region, fromTile };
    this.pump();
  }

  /**
   * One tick on the GPU at a time, and the next only once that one has landed.
   *
   * **`getCurrentTexture` blocks the main thread when the swapchain is full**, and a frame
   * asked for every 16ms while each takes 200 to draw fills it and keeps it full - so the
   * thread handling the pointer stalls inside the draw call, and the slider freezes for as
   * long as the picture takes. Waiting for the GPU here is what keeps that off the main
   * thread: an image is always free when the next draw asks for one, the controls stay live at
   * whatever rate they emit, and the picture follows at whatever rate it can.
   *
   * Both canvases through one gate, because `onSubmittedWorkDone` answers for the queue and
   * the two draws share it: gating them separately would have each waiting on the other's work
   * anyway, and twice.
   */
  private pump(): void {
    if (this.closed || this.frame !== 0 || this.drawing) return;
    if (this.pending == null && this.pendingLoupe == null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const next = this.pending;
      const loupe = this.pendingLoupe;
      this.pending = null;
      this.pendingLoupe = null;
      if (this.closed || this.pipeline == null) return;
      if (next != null) {
        this.sizeStage();
        this.pipeline.render(next, this.store.region ?? this.pipeline.wholeFrame);
      }
      // After the tick, which rewrites the uniform this reads: the queue keeps the two writes
      // and the two submits in the order they were made, so the glass gets its own window.
      if (loupe != null) {
        this.pipeline.renderLoupe(this.store.exposureEv, loupe.region, loupe.fromTile);
      }
      this.drawing = true;
      const landed = (): void => {
        this.drawing = false;
        // A denoise arrives a band at a time and each band is a picture, so the frame that just
        // landed is what paces it: submit the next one and ask for the draw that shows it.
        if (!this.closed && this.pipeline?.stepDenoise()) this.request(this.store.exposureEv);
        this.pump();
      };
      // Both arms, because a device lost mid-draw rejects - and a rejection swallowed here
      // would leave the flag set and every later frame waiting on a tick that never lands.
      void this.pipeline.drawn().then(landed, landed);
    });
  }

  /** Whether a tick is on the GPU and has not come back. */
  private drawing = false;

  /**
   * The window the glass is asking for while a frame is already in flight, and what it is a
   * window on: the frame, or the tile the pipeline is holding.
   */
  private pendingLoupe: { region: Region; fromTile: boolean } | null = null;

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
    this.store.noiseFit = null;
    this.store.levels = null;
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
    this.store.noiseFit = header.noiseFit ?? null;
    this.store.levels = { white: header.white, peak: header.peak };
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
 * The frame every tick grades, opened here through the wasm module.
 *
 * One path, under the shell as much as in a tab: every platform's webview is Chromium, so there is
 * nothing the shell could open that this cannot.
 *
 * There is no second arm. A browser that cannot run the module has no editor, deliberately: the
 * server's `/prepared` is gone, and a fall-back that produced a picture anyway is exactly how a
 * tab that had quietly stopped decoding went unnoticed.
 */
async function fetchPrepared(
  photoId: string,
  longEdge: number,
  detail: Detail,
): Promise<{
  header: PreparedHeader;
  samples: Uint16Array<ArrayBuffer>;
  /** What the loupe's tiles are built from. */
  local: LocalSource;
}> {
  const local = await preparedHere(photoId, longEdge, detail);
  const { header, samples } = framed(local.prepared);
  // The one this open had to fit, where nothing had kept one: a tile cannot fit its own, and an
  // unmatched tile is a magnifier showing a different picture from the stage it sits over.
  if (local.open.cameraMatch == null && header.cameraMatch != null) {
    local.open.cameraMatch = header.cameraMatch;
    keepCameraMatch(photoId, header.cameraMatch);
  }
  return { header, samples, local };
}

/** The worker holding this photograph's RAW, and the settings the open used, for the loupe's tiles. */
type LocalSource = { decoder: LocalDecoder; open: LocalOpen };

/** The Detail sliders the open denoises the mosaic at, as the document holds them. */
type Detail = { luminance: number; colour: number };

async function preparedHere(
  photoId: string,
  longEdge: number,
  detail: Detail,
): Promise<LocalSource & { prepared: Uint8Array }> {
  const { LocalDecoder } = await import('./local_open');
  const [settings, raw, cameraMatch] = await Promise.all([
    api.getSettings(),
    downloadedRaw(photoId),
    storedCameraMatch(photoId),
  ]);
  const open: LocalOpen = {
    longEdge: Math.round(longEdge),
    cameraMatch,
    grade: {
      peakNits: settings.hdr_peak_nits,
      referenceWhiteNits: settings.hdr_reference_white_nits,
      whiteQuantile: settings.hdr_white_quantile,
    },
    strengths: { sharpen: settings.raw_sharpen, defringe: settings.raw_defringe },
    denoiseLuminance: detail.luminance,
    denoiseColour: detail.colour,
  };
  // Kept rather than dropped once the frame is out: a tile is decoded from the same bytes, and
  // re-fetching 72MB per loupe position is the round trip this whole path exists to remove.
  const decoder = new LocalDecoder();
  await decoder.hold(raw);
  return { decoder, open, prepared: await decoder.prepare(open) };
}

/**
 * The match some earlier open or render fitted, where one has been kept.
 *
 * Half a second of the open that depends on nothing but the file. A 404 is the ordinary answer for
 * a photograph nothing has fitted yet, and then the open fits its own.
 */
async function storedCameraMatch(photoId: string): Promise<number[] | undefined> {
  const reply = await fetch(cameraMatchUrl(photoId));
  if (!reply.ok) return undefined;
  return Array.from(new Uint8Array(await reply.arrayBuffer()));
}

/**
 * Hands back a match this open had to fit, so the next one does not spend the half second again.
 *
 * Not awaited, and a failure is not raised: the picture is already on screen by then, and a
 * photograph that refits next time is slower rather than wrong. The server refuses to overwrite one
 * it already has, so this cannot race the rendition worker.
 */
function keepCameraMatch(photoId: string, match: number[]): void {
  void fetch(cameraMatchUrl(photoId), {
    method: 'PUT',
    body: new Uint8Array(match),
  }).catch(() => undefined);
}

async function downloadedRaw(photoId: string): Promise<Uint8Array<ArrayBuffer>> {
  const reply = await fetch(downloadUrl(photoId, 'original'));
  if (!reply.ok) {
    // Named and quoted: this is the first request an open makes, so it is where a photograph
    // that is not there is found out, and "404" alone leaves a reader with nothing to act on.
    const detail = (await reply.text()).slice(0, 200);
    throw new Error(`could not open ${photoId}: ${reply.status} ${detail}`);
  }
  return new Uint8Array(await reply.arrayBuffer());
}

/** `edit::encode`'s framing: a `u32` header length, that much JSON, then the samples as `u16`. */
function framed(bytes: Uint8Array): {
  header: PreparedHeader;
  samples: Uint16Array<ArrayBuffer>;
} {
  const { buffer, byteOffset, byteLength } = bytes;
  if (byteLength < 4) throw new Error('the prepared frame arrived with no header');
  const described = new DataView(buffer, byteOffset, byteLength).getUint32(0, true);
  if (described + 4 > byteLength) throw new Error('the prepared frame arrived truncated');

  return {
    header: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + described))) as PreparedHeader,
    samples: new Uint16Array(
      buffer as ArrayBuffer,
      byteOffset + 4 + described,
      (byteLength - 4 - described) >> 1,
    ),
  };
}

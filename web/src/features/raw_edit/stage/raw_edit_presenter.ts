import { action } from 'mobx';
import { type EditDoc, type EditState } from '../../../../../src/schemas/photo_edits';
import { adapterName } from '../../../adapter_name';
import { photoEditsApi } from '../../../api/photo_edits';
import { photosApi, type PreparedFrom } from '../../../api/photos';
import { preparesOnTheBackend } from './prepare_choice';
import { describe } from '../../../errors';
import type { CropGrip, CropRect } from '../crop/crop_turn';
import type { AspectKey } from '../crop/crop_aspect';
import { CropPresenter } from '../crop/crop_presenter';
import type { CropStore } from '../crop/crop_store';
import { displayIsHdr } from '../../../app/device';
import { readSetting, writeSetting } from '../../../app/local_setting';
import { adjustOf } from '../../../../../src/schemas/edit_adjust';
import type { ColourProfile, Denoiser } from '../../../../../src/schemas/photo_edits';
import { RepairPresenter } from '../repair/repair_presenter';
import { EditPresenter } from '../edit/edit_presenter';
import type { EditStore } from '../edit/edit_store';
import {
  fetchPrepared,
  prepareOf,
  preparedPicture,
  type LocalSource,
} from '../local_decode/open_photo';
import type { KeystoneGuide } from '../keystone/keystone';
import { KeystonePresenter } from '../keystone/keystone_presenter';
import type { KeystoneStore } from '../keystone/keystone_store';
import { LoupePresenter } from '../loupe/loupe_presenter';
import type { LoupeStore } from '../loupe/loupe_store';
import { PreparePresenter } from './prepare_presenter';
import { SUPERSAMPLE, stageResolution } from './stage_resolution';
import { type PreparedHeader, readPreparedHeader } from '../../../../../src/schemas/prepared';
import type { EditAdjust, Region } from '../edits';
import { isSoftProof, type SoftProof } from '../proof/soft_proof';
import type { EditTool } from '../edit_tool';
import type { GuideKind } from '../keystone/keystone_store';
import type { RepairStore } from '../repair/repair_store';
import type { OpenStep, StageStore } from './stage_store';
import type { PrinterProfile, PrintStore } from '../print/print_store';
import { PrintPresenter, type PrinterProfileSource } from '../print/print_presenter';
import { printDisplaySize } from '../print/print_scene';

const SOFT_PROOF_KEY = 'bowerbird.edit.softProof';

/** How long a pan or a zoom may be still before a finer window of the picture is fetched. */
export const REWINDOW_QUIET_MS = 220;

/** How far past the viewport tiles are loaded, as a share of it on each side. */
const TILE_REACH = 0.25;

/** The box a set of tiles spans, which is the buffer one request comes back in. */
function spanning(
  tiles: [number, number, number, number][],
): [number, number, number, number] {
  const left = Math.min(...tiles.map(([x]) => x));
  const top = Math.min(...tiles.map(([, y]) => y));
  const right = Math.max(...tiles.map(([x, , w]) => x + w));
  const bottom = Math.max(...tiles.map(([, y, , h]) => y + h));
  return [left, top, right - left, bottom - top];
}

/** The rectangle of a level to hold tiles for, from the part of the picture on screen. */
function reach(
  part: { x: number; y: number; width: number; height: number },
  canvas: [number, number],
): [number, number, number, number] {
  const [wide, tall] = canvas;
  const grow = (at: number, span: number, whole: number): [number, number] => {
    const margin = span * TILE_REACH;
    const from = Math.max((at - margin) * whole, 0);
    const to = Math.min((at + span + margin) * whole, whole);
    return [Math.floor(from), Math.max(Math.ceil(to - from), 1)];
  };
  const [x, width] = grow(part.x, part.width, wide);
  const [y, height] = grow(part.y, part.height, tall);
  return [x, y, width, height];
}

/**
 * Drives one RAW through the open-once, grade-per-tick loop.
 *
 * **Nothing here touches a GPU.** The module holds the frame, the canvases and the device, and a
 * tick is a region and a set of edits crossing to it (`local_open.ts`) - so what this class is, is
 * the decision of *what* to draw: which window, at which exposure, on a stage of which size, and
 * how rarely enough that a pointer does not outrun the display.
 *
 * **The mosaic controls are the exception**: the Detail pair and the dust three. Both stages run
 * above the demosaic, inside the open, so moving one re-prepares the photograph from the mosaic the
 * worker holds (`reprepare`) rather than riding on a tick - a band at a time, drawn as each lands,
 * which is seconds on a large photograph.
 */
export class RawEditPresenter {
  /**
   * The adapter's own ceiling, kept because `stageResolution` needs it and this thread holds no
   * device to ask: the one the picture is drawn on is the module's, in the worker.
   */
  private maxTexture = 8192;
  /**
   * The canvases already given to the worker.
   *
   * `transferControlToOffscreen` is once per element for good, so this is what stops a remount
   * from throwing on a canvas whose backing store has already gone.
   */
  private readonly handedOver = new WeakSet<HTMLCanvasElement>();
  /** Whether an open has a frame to draw, which a tick before one would draw nothing of. */
  private drawable = false;
  /** The reader's sliders, as the module's `Adjust`. Sent with the tick that has to show them. */
  private adjust: EditAdjust | null = null;
  /** The last backing store asked for, so an unchanged one is not sent again. */
  private sized: { width: number; height: number } | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private viewport: ResizeObserver | null = null;
  private density: MediaQueryList | null = null;
  /** The last CSS box the observer reported, so a density change can re-fit against it. */
  private box: { width: number; height: number } | null = null;

  /** The frame the slider is asking for while one is already in flight. */
  private pending: number | null = null;
  private frame = 0;
  private closed = false;
  private remembersProof = false;

  private photoId: string | null = null;
  /** Whether the open is of the max rendition, which every window after it has to be too. */
  private fromRendition = false;

  readonly edit: EditPresenter;
  readonly prepare: PreparePresenter;
  readonly crop: CropPresenter;
  readonly keystone: KeystonePresenter;
  readonly loupe: LoupePresenter;
  readonly print: PrintPresenter;
  /** The repair tool, which the panel and the stage drive directly. */
  readonly repair: RepairPresenter;

  constructor(
    private readonly editStore: EditStore,
    private readonly stage: StageStore,
    cropStore: CropStore,
    private readonly keystoneStore: KeystoneStore,
    repairStore: RepairStore,
    loupeStore: LoupeStore,
    private readonly printStore: PrintStore,
    printerProfiles?: PrinterProfileSource,
  ) {
    this.print = new PrintPresenter(printStore, () => this.showGeometry(), undefined, printerProfiles);
    this.crop = new CropPresenter(stage, editStore, cropStore, {
      preview: (patch) => this.preview(patch),
      write: (patch) => this.write(patch),
      settle: (patch) => this.settle(patch),
      commit: () => void this.commit(),
      showGeometry: () => this.showGeometry(),
      closeKeystone: () => this.keystone.closeForSibling(),
      closeRepair: () => this.setRepairing(false),
    });
    this.keystone = new KeystonePresenter(stage, editStore, keystoneStore, this.crop, {
      preview: (patch) => this.preview(patch),
      commit: () => void this.commit(),
      showGeometry: () => this.showGeometry(),
      closeRepair: () => this.setRepairing(false),
    });
    this.loupe = new LoupePresenter(stage, editStore, loupeStore, {
      source: () => this.local,
      photoId: () => this.photoId,
      closed: () => this.closed,
      drawable: () => this.drawable,
      handOver: (canvas) => this.handOver(canvas, 'loupe'),
      request: (region) => this.requestLoupe(region),
      clearPending: () => {
        this.pendingLoupe = null;
      },
      fail: (message) => this.fail(message),
    });
    this.prepare = new PreparePresenter(stage, this.loupe, this);
    this.repair = new RepairPresenter(stage, editStore, keystoneStore, repairStore, {
      local: () => this.local,
      closed: () => this.closed,
      preview: (patch) => this.preview(patch),
      write: (patch) => void this.write(patch),
      settle: (patch) => this.settle(patch),
      flushReprepare: () => this.prepare.flush(),
      swept: () => this.prepare.swept(),
      rewindow: () => this.rewindow(),
      closeCrop: () => this.crop.closeForSibling(),
      closeKeystone: () => this.keystone.closeForSibling(),
      showGeometry: () => this.showGeometry(),
      fail: (why) => this.fail(why),
    });
    this.edit = new EditPresenter(editStore, this, this.repair);
  }

  /**
   * Gives a canvas to the worker, which draws on it from there.
   *
   * **Once per element, for good.** `transferControlToOffscreen` moves the backing store to the
   * worker and the element can never take a context on this thread again, so a remount that
   * transferred the same element twice would throw - and React remounts the loupe whenever the
   * glass is picked up.
   */
  private async handOver(
    canvas: HTMLCanvasElement,
    which: 'stage' | 'loupe',
  ): Promise<void> {
    const local = this.local;
    if (local == null || this.handedOver.has(canvas)) return;
    this.handedOver.add(canvas);
    const wanted = which === 'stage' ? this.stageSize() : null;
    const size = wanted ?? { width: canvas.width || 1, height: canvas.height || 1 };
    const offscreen = canvas.transferControlToOffscreen();
    await local.decoder.attach(which, offscreen, size.width, size.height);
    if (which === 'stage') this.drawable = true;
  }

  /**
   * The canvas the tick draws into, once React has mounted it.
   *
   * The configuration is the module's now - `rgba16float` with `toneMapping: extended`, which is
   * what makes the compositor show values above SDR white (§7) - because the surface is opened
   * where the frame is. What is left here is the box it has to fit.
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
        this.request(this.editStore.exposureEv);
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
    this.request(this.editStore.exposureEv);
  }

  get displaySize(): { width: number; height: number } {
    return printDisplaySize(
      this.keystoneStore.output,
      this.printStore.open && this.printStore.surface && this.printStore.scene.framed,
    );
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
  @action.bound
  private stageSize(): { width: number; height: number } | null {
    const box = this.box;
    const region = this.stage.region;
    if (box == null || region == null) return null;
    if (box.width === 0 || box.height === 0) return null;

    const scenePrint = this.printStore.hanging;
    const size = stageResolution(
      box,
      scenePrint ? { x: 0, y: 0, ...box } : region,
      this.maxTexture,
      scenePrint ? 1 : SUPERSAMPLE,
    );
    if (size.width === this.sized?.width && size.height === this.sized?.height) return null;
    this.sized = size;
    this.stage.stage = size;
    return size;
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
    const picture = this.displaySize;
    const width = Math.min(Math.max(region.width, 1), picture.width);
    const height = Math.min(Math.max(region.height, 1), picture.height);
    const next = {
      width,
      height,
      x: Math.min(Math.max(region.x, 0), picture.width - width),
      y: Math.min(Math.max(region.y, 0), picture.height - height),
    };
    const held = this.stage.region;
    if (
      held != null &&
      held.x === next.x &&
      held.y === next.y &&
      held.width === next.width &&
      held.height === next.height
    ) {
      return;
    }
    this.stage.region = next;
    this.request(this.editStore.exposureEv);
    this.wantWindow();
  }

  /**
   * Opens the picture behind `photoId` and grades it at `longEdge` pixels on its long edge, or
   * opens its max rendition to show rather than edit: every edit is already in that, so it is
   * drawn at neutral and the saved edits are never read.
   *
   * **The recipe is read here rather than passed in**, and awaited: which device prepares the
   * picture is a question about the recipe (`prepare_choice.ts`), and a page that had not finished
   * reading the detail yet would answer it as "an ordinary photograph" - which for a composite
   * means downloading a file that does not exist. One small row, alongside the document.
   *
   * Never rejects: both callers fire this and forget it, so anything escaping would leave
   * the page at "loading" with no reason given.
   */
  async open(photoId: string, longEdge: number | 'rendition'): Promise<void> {
    this.begin();
    this.edit.begin(photoId);
    this.photoId = photoId;
    this.fromRendition = longEdge === 'rendition';
    // Awaited before the decode rather than alongside it: the open denoises the mosaic at this
    // document's Detail, so the document is an input to the decode rather than something applied
    // to a frame that is already prepared. One small row ahead of seconds of LibRaw.
    const edits = this.fromRendition ? Promise.resolve(null) : photoEditsApi.checkpoint(photoId).catch(() => null);
    // The recipe, for the one decision that cannot be made without it. Alongside the document
    // rather than after it: both are small rows and both are wanted before the decode.
    const described = photosApi.get(photoId).catch(() => null);
    try {
      // Asked here only to say whether there is one and to name it: the device the picture is
      // drawn on is the module's own, opened in the worker where the frame lives, and this
      // thread never holds a GPU object at all.
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter == null) {
        this.fail('this browser has no WebGPU, which the editor now needs');
        return;
      }
      this.describeAdapter(adapter);
      this.maxTexture = adapter.limits.maxTextureDimension2D;

      const saved = await edits;
      if (this.closed) return;
      const mosaic = prepareOf(saved?.doc);
      // What the frame arrives holding, so the first settle at these positions asks for nothing.
      // Before `applyState` below, which would otherwise ask for a re-prepare to the settings the
      // decode is about to open at.
      this.prepare.seed(mosaic);
      // **Before the decode, not after it.** The document is a small row and the frame is seconds,
      // so the panel can show the reader their own settings while the picture is still coming -
      // shut rather than absent, which every control already is until the status is live. A read
      // that failed leaves `doc` null, which is the editor usable at neutral.
      if (saved != null) this.applyState(saved);
      this.edit.opened(saved);
      // A read that failed leaves this at the local arm, which is right for every ordinary
      // photograph.
      const photo = await described;
      const onTheBackend = photo != null && preparesOnTheBackend(photo.recipe, photo);
      const { header, local } = longEdge === 'rendition'
        ? await fetchPrepared(photoId, 0, mosaic, true, this.reached, true)
        : await fetchPrepared(photoId, longEdge, mosaic, onTheBackend, this.reached);
      if (this.closed) {
        // Closed here rather than left to `close`, which has already run and found no decoder
        // to take: leaving it would hold this photograph's RAW and frames for the life of the page.
        local.decoder.close();
        return;
      }
      this.local = local;
      // A picture prepared elsewhere arrives without its repairs, which are drawn here: so the first
      // `preview` below finds them missing and sends them.
      if (local.onTheBackend) this.prepare.seed({ ...mosaic, repairs: [] });

      const canvas = this.canvas;
      if (canvas == null) {
        this.fail('the stage was not mounted before the RAW arrived');
        return;
      }
      // The whole of it, which is what the open asked for with nothing in the URL: what `enough`
      // measures a zoom against, so the first one past this resolution fetches a window.
      this.took(header);
      this.opened(header, local.onTheBackend);
      // The canvas goes to the worker, where the frame is. Re-attached rather than left as it
      // was: the observer needs a region to size against, and there was none when React handed
      // the element over.
      await this.handOver(canvas, 'stage');
      if (this.closed) return;
      this.attach(canvas);

      // Through `preview` rather than `request` alone: the pipeline holds the sliders
      // separately from the tick's exposure, so a document has to reach both or the frame
      // opens graded by the exposure and nothing else. That now includes the denoise, which
      // is a chain of passes rather than a uniform word. A read that failed leaves `doc`
      // null and `preview` returns on it, which is the editor usable at neutral.
      if (this.fromRendition) this.draw();
      else this.preview({});
    } catch (error) {
      if (!this.closed) this.fail(describe(error));
    }
  }

  previewExposure(ev: number): void {
    this.edit.previewExposure(ev);
  }

  preview(patch: Partial<EditDoc>): void {
    this.edit.preview(patch);
  }

  private write(patch: Partial<EditDoc>): EditDoc | null {
    return this.edit.write(patch);
  }

  drawEdit(next: EditDoc): void {
    // Everything but the exposure, which the tick carries as a gain. Kept here and sent with the
    // tick rather than pushed per move: a pointer emits far more positions than a display shows,
    // and only the one the next frame reads has to have arrived.
    this.adjust = adjustOf(next);
    // Not part of the tick, and not per move. Every other control reaches the picture through the
    // adjust above and costs nothing; these are the whole decode below the mosaic and a rebuild of
    // the blur the presence sliders read, which at 24MP is far more than a pointer emits positions
    // for.
    this.prepare.want(prepareOf(next));
    this.draw();
  }

  prepareEdit(doc: EditDoc): void {
    this.prepare.want(prepareOf(doc));
  }

  draw(): void {
    this.request(this.editStore.exposureEv);
  }

  isClosed(): boolean {
    return this.closed;
  }

  localSource(): LocalSource | null {
    return this.local;
  }

  openedPhotoId(): string | null {
    return this.photoId;
  }

  clearLevel(): void {
    this.level = null;
  }

  @action.bound
  setRepreparing(running: boolean): void {
    this.stage.repreparing = running;
  }

  failPrepare(message: string): void {
    this.fail(message);
  }

  setCropping(open: boolean): void {
    if (open) this.leaveSheet();
    this.crop.setCropping(open);
  }

  dragCrop(from: CropRect, grip: CropGrip | null, by: { x: number; y: number }, settle: boolean): void {
    this.crop.dragCrop(from, grip, by, settle);
  }

  previewCrop(rect: CropRect): void {
    this.crop.previewCrop(rect);
  }

  settleCrop(rect: CropRect): void {
    this.crop.settleCrop(rect);
  }

  setCropAspect(key: AspectKey): void {
    this.crop.setCropAspect(key);
  }

  turn(by: 90 | -90): void {
    this.crop.turn(by);
  }

  @action.bound
  setTool(tool: EditTool): void {
    this.setCropping(tool === 'crop');
    this.setKeystoning(tool === 'perspective');
    this.setRepairing(tool === 'repair');
    this.setLoupe(tool === 'loupe');
  }

  /** A tool works on the picture as it lies, so a sheet being turned in a room goes flat for it. */
  private leaveSheet(): void {
    if (this.stage.softProof === 'print3d') this.setSoftProof('print');
  }

  setRepairing(open: boolean): void {
    if (open) this.leaveSheet();
    this.repair.setRepairing(open);
  }

  setLoupe(open: boolean): void {
    if (open) this.leaveSheet();
    this.loupe.setLoupe(open);
  }

  moveLoupe(at: { x: number; y: number } | null, box: { width: number; height: number }): void {
    this.loupe.moveLoupe(at, box);
  }

  zoomLoupe(notches: number, box: { width: number; height: number }): void {
    this.loupe.zoomLoupe(notches, box);
  }

  setLoupeMagnification(magnification: number, box: { width: number; height: number }): void {
    this.loupe.setLoupeMagnification(magnification, box);
  }

  /** What this tab opens and magnifies from, until it has opened one. */
  private local: LocalSource | null = null;
  private sentProfile: PrinterProfile | null = null;

  attachLoupe(canvas: HTMLCanvasElement | null): void {
    this.loupe.attachLoupe(canvas);
  }

  setCropToFit(on: boolean): void {
    this.crop.setCropToFit(on);
  }

  previewStraighten(degrees: number): void {
    this.crop.previewStraighten(degrees);
  }

  settleStraighten(degrees: number): void {
    this.crop.settleStraighten(degrees);
  }

  setKeystoning(open: boolean): void {
    if (open) this.leaveSheet();
    this.keystone.setKeystoning(open);
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
  followGeometry(): void {
    // The geometry rides on the next tick, which is requested below: sending it now would be a
    // second message the draw does not wait for.
    const { width, height } = this.displaySize;
    if (width === this.shown.width && height === this.shown.height) return;
    this.shown = { width, height };
    // The whole of it, which is what the stage's own refit settles on: it resets the view
    // whenever the shape changes, and `showRegion` returns early on a region it agrees with.
    this.stage.region = { x: 0, y: 0, width, height };
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
    this.request(this.editStore.exposureEv);
  }

  setGuides(guides: readonly KeystoneGuide[], settle: boolean): void {
    this.keystone.setGuides(guides, settle);
  }

  setGuideKind(kind: GuideKind): void {
    this.keystone.setGuideKind(kind);
  }

  /**
   * What the stage proofs against. Nothing is saved: the edits have not moved. Remembered for the
   * next edit only once `restoreSoftProof` has run, so a proof the viewer asked for is not one.
   */
  @action.bound
  setSoftProof(proof: SoftProof): void {
    this.stage.softProof = proof;
    if (this.remembersProof) writeSetting(SOFT_PROOF_KEY, proof);
    // The sheet takes the whole stage, which a geometry tool or a loupe has no picture to act on.
    if (proof === 'print3d') {
      this.setCropping(false);
      this.setKeystoning(false);
      this.setRepairing(false);
      this.setLoupe(false);
    }
    this.print.setView(proof === 'print' ? 'flat' : proof === 'print3d' ? 'sheet' : null);
  }

  /** The proof this reader last edited under, which an edit opens at. */
  @action.bound
  restoreSoftProof(): void {
    this.remembersProof = true;
    const remembered = readSetting(SOFT_PROOF_KEY);
    this.setSoftProof(isSoftProof(remembered) ? remembered : 'hdr');
  }

  removeGuide(index: number): void {
    this.keystone.removeGuide(index);
  }

  clearKeystone(): void {
    this.keystone.clearKeystone();
  }

  previewBalance(patch: { temperature?: number; tint?: number }): void {
    this.edit.previewBalance(patch);
  }

  settleBalance(patch: { temperature?: number; tint?: number }): void {
    this.edit.settleBalance(patch);
  }

  settleExposure(ev: number): void {
    this.edit.settleExposure(ev);
  }

  settle(patch: Partial<EditDoc>): void {
    this.edit.settle(patch);
  }

  setColourProfile(colourProfile: ColourProfile): void {
    this.edit.setColourProfile(colourProfile);
  }

  setDenoiser(denoiser: Denoiser): void {
    this.edit.setDenoiser(denoiser);
  }

  flushReprepare(): void {
    this.prepare.flush();
  }

  /**
   * Asks for whatever tiles the reader has moved towards, once they have stopped moving.
   *
   * **Only where the picture was prepared elsewhere**, which is the only arm that has levels: a
   * tab that decoded the RAW holds the whole photograph and every zoom is already answered from
   * it.
   *
   * Debounced rather than per frame, for `wantReprepare`'s reason - a pinch is sixty regions a
   * second. `TILE_REACH` keeps a quarter of a viewport in hand on every side, so a reader has to
   * cross that before anything they are looking at is missing.
   */
  private wantWindow(): void {
    if (!this.stage.preparedElsewhere || this.closed) return;
    if (this.windowTimer != null) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => void this.rewindow(), REWINDOW_QUIET_MS);
  }

  /**
   * The picture the reader is looking at, at the resolution they are looking at it.
   *
   * **Two things send this, and the second is why it cannot be a zoom test alone.** A zoom past
   * what the held window resolves wants a finer one; a pan out of the held window wants a
   * different one at the same level, and the picture there is black until it arrives
   * (`frame.slang`'s `outside`). So the test is "is what I hold enough for what is on screen",
   * and `enough` is what answers it.
   *
   * One in flight, and the newer wins: a reader who zooms, waits, and zooms again would otherwise
   * have two windows racing to be the one drawn, and the loser is the one they can see.
   */
  async rewindow(): Promise<void> {
    const photoId = this.photoId;
    const region = this.stage.region;
    const stage = this.stage.stage;
    const source = this.local;
    if (photoId == null || region == null || stage == null || source == null) return;
    if (!source.onTheBackend) return;
    // A window landing on an editor that has already failed would put it back to `live` over a
    // pipeline that is not, which is `fail`'s own rule one call further out.
    if (this.stage.status === 'failed') return;

    // **Claimed before the first await, not after it.** Everything below waits twice - on the
    // module for the mapping and on the server for the picture - and a newer pass has to be able
    // to take this one's place at either point. Taken after an await instead, two passes would
    // each abort the other's fetch in whichever order their awaits happened to resolve, and the
    // window drawn would be the older one's.
    this.rewindowing?.abort();
    const attempt = new AbortController();
    this.rewindowing = attempt;
    const mine = (): boolean => !this.closed && this.rewindowing === attempt;

    try {
      // **What part of the *picture* that region reads, which the geometry decides.** Asked of the
      // module, which maps the two onto each other for every pixel it draws: a crop moves the
      // origin, a turn swaps the axes and a straighten rotates, so a fraction of the output is not
      // a fraction of the picture - and a panorama framed off-centre by its own align is enough to
      // see the difference.
      const [x = 0, y = 0, width = 1, height = 1] = await source.decoder.picturePart(this.atTheLevel(region));
      if (!mine() || width <= 0 || height <= 0) return;
      const part = { x, y, width, height };
      const shown = { region: part, stage: Math.max(stage.width, stage.height) };

      // **A level is fetched as a window and a pan is fetched as tiles**, which is the whole
      // division of labour. A zoom past what the held level resolves needs content at a scale
      // nothing here has, so the server picks the level from the region and sends a window of it -
      // the tiles of that window seed the grid. Every pan after that asks the module what it is
      // short of and fetches only that.
      if (!this.enough(shown)) {
        const framed = await preparedPicture(photoId, { ...shown, signal: attempt.signal }, this.preparedFrom());
        if (!mine()) return;
        // Every square the window covers, which is what an empty list means: a whole level's
        // window is the whole of what was wanted, so there is no corner to discard.
        const kept = readPreparedHeader(await source.decoder.takeTiles(framed, []));
        // The tiles keep either way, being keyed by their level - but a superseded pass's *level*
        // landing after a newer one's would draw the newer tiles at the older scale.
        if (!mine()) return;
        this.took(kept);
      }

      const level = this.level;
      if (!mine() || level == null) return;
      // Bounded, because the loop's exit is the module saying it is no longer short of anything:
      // one round fetches, the next assembles. A third would mean a square that cannot be stored,
      // and spinning on it would be a request a second for the life of the open.
      for (let round = 0; round < 3; round += 1) {
        const { missing } = await source.decoder.showTiles(level.canvas, reach(part, level.canvas));
        if (!mine()) return;
        if (missing == null) break;
        // **The squares as well as the box they span.** One request covers them all, because a
        // prepare's fixed cost is a file open and a region decode for every source it touches -
        // but the library is told the squares too, so an L of them is decoded per source for the
        // box bounding *that source's* own squares and a source no square reaches is never
        // opened. Handed only the box, a diagonal pan decodes every source for a corner nobody
        // asked about.
        const framed = await preparedPicture(
          photoId,
          { level: level.number, at: spanning(missing), parts: missing, signal: attempt.signal },
          this.preparedFrom(),
        );
        if (!mine()) return;
        const kept = readPreparedHeader(await source.decoder.takeTiles(framed, missing));
        if (!mine()) return;
        this.took(kept);
      }
      this.request(this.editStore.exposureEv);
    } catch (error) {
      // A window the reader has already moved past is not a failure to report: the abort above is
      // this presenter's own doing, and the picture it was going to replace is still on screen.
      if (attempt.signal.aborted) return;
      this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.rewindowing === attempt) this.rewindowing = null;
    }
  }

  private preparedFrom(): PreparedFrom {
    return this.fromRendition ? 'rendition' : this.prepare.developing;
  }

  /**
   * What arrived, as the fractions of the picture it covers and the resolution it covers them at.
   *
   * **Measured off the header rather than off the request.** The window served is grown past the
   * region asked for, so slack to pan into, and it is cut at the level's own even columns - so a
   * client that remembered its own request would refetch on the first pixel of pan and would think
   * it had less than it does.
   */
  @action.bound
  private took(header: PreparedHeader): void {
    const placed = header.window;
    const [canvasWide = 1, canvasTall = 1] = placed?.canvas ?? [header.width, header.height];
    const [pictureWide = canvasWide] = header.picture ?? [canvasWide];
    this.levelScale = canvasWide / Math.max(pictureWide, 1);
    // **The level, so a pan can ask for tiles of it.** Named back by the header rather than worked
    // out here, because deriving it from the canvas against the picture is a second copy of
    // `composite_job::sized` - rounding, composite ceiling and all.
    this.level = { number: header.level ?? 0, canvas: [canvasWide, canvasTall] };
    // The picture's own pixels, said by the side that knows how many halvings it has. A reader
    // zoomed past 1:1 is looking at the bottom rung, and without this every pan for the rest of
    // the open costs a round trip for a picture identical to the one on screen.
    this.atFinest = header.finest === true;
  }

  /**
   * Whether the level in hand resolves what is on screen.
   *
   * **Resolution alone, because coverage is the module's question.** It holds the tiles, so it is
   * what answers whether the viewport is covered, and it answers by naming what to fetch. What is
   * left here is the one thing tiles cannot fix: a level too coarse for the stage has no tile
   * anywhere on it that would show the reader something they cannot already see.
   */
  private enough(shown: {
    region: { x: number; y: number; width: number; height: number };
    stage: number;
  }): boolean {
    const level = this.level;
    if (level == null) return false;
    return this.atFinest || shown.region.width * level.canvas[0] >= shown.stage;
  }

  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private rewindowing: AbortController | null = null;
  /** The level the module is holding tiles of, and that level's own shape. */
  private level: { number: number; canvas: [number, number] } | null = null;
  /** Whether the server has already answered a finer ask with the level it had just served. */
  private atFinest = false;
  private commit(): Promise<void> {
    return this.edit.commit();
  }

  async undo(): Promise<void> {
    await this.edit.undo();
  }

  async redo(): Promise<void> {
    await this.edit.redo();
  }

  cancel(): Promise<boolean> {
    return this.edit.cancel();
  }

  private applyState(state: EditState, keepDoc = false): void {
    this.edit.applyState(state, keepDoc);
  }

  close(): void {
    if (this.closed) return;
    // A re-prepare owed to a control nobody is holding any more, on a pipeline about to be
    // destroyed: cancelled rather than flushed.
    this.prepare.close();
    this.loupe.close();
    this.print.close();
    // Same for a window the reader has stopped looking at, and the fetch it may already have
    // started: a hundred megabytes arriving for a closed editor is bandwidth spent, and a worker
    // message to a decoder that is about to be freed.
    if (this.windowTimer != null) clearTimeout(this.windowTimer);
    this.windowTimer = null;
    this.rewindowing?.abort();
    this.rewindowing = null;
    this.repair.close();
    this.edit.close();

    this.closed = true;
    this.viewport?.disconnect();
    this.viewport = null;
    this.density?.removeEventListener('change', this.onDensity);
    this.density = null;
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.drawable = false;
    // The thread the picture was drawn on, holding the RAW, the frame, the canvases and the
    // module's heap - all of it, which is why there is nothing else to destroy here.
    this.local?.decoder.close();
    this.local = null;
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
    if (this.closed || !this.drawable) return;
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
  private requestLoupe(region: Region): void {
    if (this.closed || !this.drawable) return;
    this.pendingLoupe = region;
    this.pump();
  }

  private pump(): void {
    if (this.closed || this.frame !== 0 || this.drawing) return;
    if (this.pending == null && this.pendingLoupe == null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const next = this.pending;
      const loupe = this.pendingLoupe;
      const print = this.printStore.open ? this.printStore.scene : null;
      this.pending = null;
      this.pendingLoupe = null;
      const local = this.local;
      if (this.closed || local == null || !this.drawable) return;
      const profile = this.printStore.printerProfile;
      const profileChanged = profile !== this.sentProfile;
      this.sentProfile = profile;
      this.drawing = true;
      const landed = (error?: unknown): void => {
        this.drawing = false;
        // **A refused command is reported here or nowhere.** A validation error rejects nothing
        // on the device: the dispatch is dropped and the chain runs on, so the reader is told
        // `live` over a canvas that is black or confidently wrong. The module keeps the first one
        // and hands it back on the next tick (`gpu::refusal`); this is what puts it on screen.
        if (error != null) this.fail(describe(error));
        else {
          if (next != null) this.drew(print == null ? 'photo' : 'print');
          const framed = print?.presentation === 'surface' && print.framed;
          if (framed !== this.framedSurface) {
            this.framedSurface = framed;
            this.wantWindow();
          }
        }
        this.pump();
      };
      // One message carrying both draws and the size they read: the worker applies them in the
      // order they are written here, which is the order the page's own two submits were in.
      //
      // Both arms, because a worker that died mid-draw rejects too - and a rejection swallowed
      // here would leave the flag set and every later frame waiting on a tick that never lands.
      void local.decoder
        .tick({
          ev: next ?? this.editStore.exposureEv,
          drawStage: next != null,
          region: this.stage.region == null ? null : this.atTheLevel(this.stage.region),
          loupe,
          adjust: this.adjust,
          geometry: this.keystoneStore.geometry,
          proof: {
            output: this.stage.softProof === 'srgb' ? 'srgb' : 'hdr',
            intent: this.printStore.scene.renderingIntent,
            displayHdr: displayIsHdr(),
          },
          print,
          ...(profileChanged ? { printerProfile: profile?.bytes ?? null } : {}),
          stage: next == null ? null : this.stageSize(),
        })
        .then(() => landed(), landed);
    });
  }

  @action.bound
  private drew(mode: 'photo' | 'print'): void {
    this.stage.renderedMode = mode;
  }

  /**
   * The region in the pixels of the level the module is holding, which is what a draw indexes by.
   *
   * **The one place the page's units and the module's meet.** This page states the region against
   * the picture at scale 1, because that is what does not move when the reader is served a finer
   * window; the draw reads it against the level it holds. Identity for a tab's own open and for a
   * whole level, which is every picture that is not a window of a canvas.
   */
  private atTheLevel(region: Region): Region {
    const scale = this.levelScale;
    if (scale === 1) return region;
    return {
      x: region.x * scale,
      y: region.y * scale,
      width: region.width * scale,
      height: region.height * scale,
    };
  }

  /** Level pixels per picture pixel, which a whole picture has one of. */
  private levelScale = 1;

  /** Whether a tick is on the GPU and has not come back. */
  private drawing = false;
  private framedSurface = false;

  /**
   * The window the glass is asking for while a frame is already in flight.
   *
   * In the tile's own coordinates where the module is holding one, which is why nothing here says
   * which: `drawLoupe` takes the window's origin off before it asks, and the module draws through
   * whatever it is holding.
   */
  private pendingLoupe: Region | null = null;

  @action.bound
  private describeAdapter(adapter: GPUAdapter): void {
    this.stage.adapter = adapterName(adapter);
  }

  @action.bound
  private begin(): void {
    this.stage.status = 'opening';
    this.stage.step = 'preparing';
    this.stage.message = '';
    this.stage.width = 0;
    this.stage.height = 0;
    this.stage.matched = false;
    this.stage.mosaic = true;
    this.stage.noiseFit = null;
    this.stage.detail = null;
    this.stage.defocus = null;
    this.stage.levels = null;
  }

  @action.bound
  private reached(step: OpenStep): void {
    if (this.closed || this.stage.status !== 'opening') return;
    this.stage.step = step;
  }

  @action.bound
  private opened(header: PreparedHeader, preparedElsewhere: boolean): void {
    this.describe(header, preparedElsewhere);
    // Whatever the document already says - an imported sidecar routinely arrives cropped - so
    // the first frame drawn is the picture rather than the frame it was taken out of. The frame
    // has only just arrived, so this is the first shape there has been and it seeds the region.
    this.shown = { width: 0, height: 0 };
    this.followGeometry();
  }

  @action.bound
  private describe(header: PreparedHeader, preparedElsewhere: boolean): void {
    this.stage.status = 'live';
    this.stage.message = '';
    // **The picture at scale 1, not the buffer and not the level.** Everything this page states is
    // against the photograph - the crop fractions, the region a zoom moves, the output size a tile
    // is laid out by - so a window's own size here would crop a panorama to whatever rectangle the
    // reader last asked for, and the *level's* size would move under them every time a finer
    // window arrived, resetting the view to fitted on each one. `levelScale` is the one place the
    // two meet.
    this.stage.width = header.picture?.[0] ?? header.width;
    this.stage.height = header.picture?.[1] ?? header.height;
    this.stage.matched = header.matched;
    this.stage.preparedElsewhere = preparedElsewhere;
    this.stage.mosaic = header.mosaic;
    this.edit.setAsShot(header.asShot);
    this.stage.noiseFit = header.noiseFit ?? null;
    this.stage.detail = header.detail;
    this.stage.defocus = header.defocus;
    // All three or none: a tile handed a white and a peak without a floor is refused whole
    // (`tone::Levels::usable`), so there is nothing to hold.
    this.stage.levels =
      header.floor == null
        ? null
        : { white: header.white, peak: header.peak, floor: header.floor };
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
    // A closed editor has no reader to tell, and closing is itself a source of rejections: the
    // decoder refuses everything in flight on the way out, so the tick that was on the GPU when
    // the reader hit Done comes back as an error. Reporting that would be the editor announcing a
    // failure at the moment it stopped existing.
    if (this.closed || this.stage.status === 'failed') return;
    this.stage.status = 'failed';
    this.stage.message = message;
  }
}

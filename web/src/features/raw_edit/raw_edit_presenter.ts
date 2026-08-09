import { action } from 'mobx';
import { ApiError, api, preparedPath, type EditDoc, type EditState } from '../../api/client';
import { send } from '../../api/transport';
import { describe } from '../../errors';
import {
  TickPipeline,
  type PreparedHeader,
  type Region,
  stageResolution,
  tickFeatures,
  tickLimits,
} from './gpu/tick_pipeline';
import type { RawEditStore, SaveStatus } from './raw_edit_store';

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
  private pipeline: TickPipeline | null = null;
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

  constructor(private readonly store: RawEditStore) {}

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
        this.fitStage(box.width, box.height);
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
    const box = this.box;
    if (box != null) this.fitStage(box.width, box.height);
  }

  /**
   * Sizes the canvas backing store for the viewport and redraws into it.
   *
   * Held to what the frame can actually fill, which is why it needs the region: on a
   * 61MP frame the whole picture is more than any display, and zoomed in far enough it is
   * fewer source pixels than the panel has.
   */
  @action.bound
  private fitStage(cssWidth: number, cssHeight: number): void {
    const canvas = this.canvas;
    const device = this.device;
    if (canvas == null || device == null || cssWidth === 0 || cssHeight === 0) return;
    const region = this.store.region;
    if (region == null) return;

    const size = stageResolution({ width: cssWidth, height: cssHeight }, region, device.limits.maxTextureDimension2D);
    if (canvas.width === size.width && canvas.height === size.height) return;
    canvas.width = size.width;
    canvas.height = size.height;
    this.request(this.store.exposureEv);
  }

  /**
   * Zoom and pan: the rectangle of the frame on screen, held inside the frame.
   *
   * Re-fitted rather than only redrawn, because the region is half of what the stage's
   * resolution is computed from: zoomed in, fewer source pixels have to cover the same box,
   * so the backing store is capped by the region's own resolution rather than the panel's -
   * past 1:1 there is nothing left to resolve and the compositor's upscale is the honest
   * answer. Zoomed back out it has to grow again.
   */
  @action.bound
  showRegion(region: Region): void {
    const width = Math.min(Math.max(region.width, 1), this.store.width);
    const height = Math.min(Math.max(region.height, 1), this.store.height);
    const next = {
      width,
      height,
      x: Math.min(Math.max(region.x, 0), this.store.width - width),
      y: Math.min(Math.max(region.y, 0), this.store.height - height),
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

    const box = this.box;
    if (box == null) {
      this.request(this.store.exposureEv);
      return;
    }
    // Which redraws, whether or not the backing store had to change.
    this.fitStage(box.width, box.height);
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
        requiredFeatures: tickFeatures(adapter),
        requiredLimits: tickLimits(adapter),
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
      context.configure({
        device,
        format: 'rgba16float',
        colorSpace: 'display-p3',
        alphaMode: 'opaque',
        // Values above 1 reach the panel only with this, and it is measured working in
        // Chromium and in Safari 26 (§7). A browser that ignores the member shows an SDR
        // picture rather than failing, which is why the probe page exists.
        toneMapping: { mode: 'extended' },
      } as GPUCanvasConfiguration);

      this.pipeline = new TickPipeline(device, context, header, samples);
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
      if (saved != null && !this.closed) {
        this.applyState(saved);
        // Through `preview` rather than `request` alone: the pipeline holds the sliders
        // separately from the tick's exposure, and a saved document has to reach both or
        // the frame opens graded by the exposure and nothing else.
        this.preview({});
      }
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
    });
    this.request(this.store.exposureEv);
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
    void this.commit();
  }

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
    if (!keepDoc) this.store.doc = state.doc;
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
    this.store.region = { x: 0, y: 0, width: header.width, height: header.height };
  }

  @action.bound
  private fail(message: string): void {
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

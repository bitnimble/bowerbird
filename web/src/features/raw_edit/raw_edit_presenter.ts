import { action } from 'mobx';
import { preparedPath } from '../../api/client';
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
import type { RawEditStore } from './raw_edit_store';

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
    } catch (error) {
      if (!this.closed) this.fail(describe(error));
    }
  }

  /** The exposure the slider is at, while it moves. */
  @action.bound
  previewExposure(ev: number): void {
    this.store.exposureEv = ev;
    this.request(ev);
  }

  /** The frame that gets judged. The same one, because the tick is full resolution. */
  @action.bound
  settleExposure(ev: number): void {
    this.previewExposure(ev);
  }

  close(): void {
    if (this.closed) return;
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
    this.store.exposureEv = 0;
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

import { action } from 'mobx';
import { preparedUrl } from '../../api/client';
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
 * a dispatch chain over a texture that never leaves the GPU, so there is no worker, no
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

  /** The frame the slider is asking for while one is already in flight. */
  private pending: number | null = null;
  private frame = 0;
  private closed = false;
  private windowStarted = 0;
  private windowFrames = 0;

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
    this.canvas = canvas;
    if (canvas == null) return;
    // The observer's own box rather than `getBoundingClientRect`: the size arrives with
    // the callback, so nothing on this path reads layout. It also fires once on observe,
    // which is what gives the canvas its first size.
    this.viewport = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box != null) this.fitStage(box.width, box.height);
    });
    this.viewport.observe(canvas);
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
    this.store.stageWidth = size.width;
    this.store.stageHeight = size.height;
    this.request(this.store.exposureEv);
  }

  /** Zoom and pan: the rectangle of the frame on screen, held inside the frame. */
  @action.bound
  showRegion(region: Region): void {
    const width = Math.min(Math.max(region.width, 1), this.store.width);
    const height = Math.min(Math.max(region.height, 1), this.store.height);
    this.store.region = {
      width,
      height,
      x: Math.min(Math.max(region.x, 0), this.store.width - width),
      y: Math.min(Math.max(region.y, 0), this.store.height - height),
    };
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
      const device = await adapter.requestDevice({
        requiredFeatures: tickFeatures(adapter),
        requiredLimits: tickLimits(adapter),
      });
      if (this.closed) return;
      this.device = device;
      device.lost.then((reason) => {
        if (!this.closed && reason.reason !== 'destroyed') this.fail(`the GPU device was lost: ${reason.message}`);
      });
      this.describeAdapter(adapter);

      this.preparing();
      const started = performance.now();
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
      this.opened(header, performance.now() - started);
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
      const started = performance.now();
      this.pipeline.render(next, this.store.region ?? this.pipeline.wholeFrame);
      this.measure(performance.now() - started);
    });
  }

  @action.bound
  private measure(ms: number): void {
    this.store.gradeMs = Math.round(ms);
    const now = performance.now();
    this.windowFrames += 1;
    if (this.windowStarted === 0) this.windowStarted = now;
    const elapsed = now - this.windowStarted;
    if (elapsed < 500) return;
    this.store.fps = Math.round((this.windowFrames / elapsed) * 1000);
    this.windowStarted = now;
    this.windowFrames = 0;
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
    this.store.openMs = 0;
    this.store.gradeMs = 0;
    this.store.fps = 0;
  }

  @action.bound
  private preparing(): void {
    this.store.status = 'preparing';
    this.store.message = 'decoding, fitting the camera match and warping';
  }

  @action.bound
  private opened(header: PreparedHeader, ms: number): void {
    this.store.status = 'live';
    this.store.message = '';
    this.store.width = header.width;
    this.store.height = header.height;
    this.store.matched = header.matched;
    this.store.openMs = Math.round(ms);
    this.store.region = { x: 0, y: 0, width: header.width, height: header.height };
  }

  @action.bound
  private fail(message: string): void {
    this.store.status = 'failed';
    this.store.message = message;
  }
}

/**
 * The prepared frame, header and all, from whichever side of the app is running.
 *
 * The desktop shell runs `edit::prepare` in its own process, so the frame never leaves the
 * machine; the browser asks the server for the same call over HTTP. One `PreparedHeader`
 * either way, because both are `edit::encode`'s framing.
 */
async function fetchPrepared(
  photoId: string,
  longEdge: number,
): Promise<{ header: PreparedHeader; samples: Uint16Array<ArrayBuffer> }> {
  return desktop() == null
    ? await overHttp(photoId, longEdge)
    : await inProcess(photoId, longEdge);
}

/** Tauri's IPC, where the app is the desktop shell rather than a page. */
function desktop(): ((command: string, args: unknown) => Promise<ArrayBuffer>) | null {
  const bridge = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const invoke = bridge?.core?.invoke;
  return typeof invoke === 'function'
    ? (invoke as (command: string, args: unknown) => Promise<ArrayBuffer>)
    : null;
}

async function inProcess(
  photoId: string,
  longEdge: number,
): Promise<{ header: PreparedHeader; samples: Uint16Array<ArrayBuffer> }> {
  const invoke = desktop();
  if (invoke == null) throw new Error('the desktop bridge went away mid-open');
  // The shell owns no library yet, so the path still comes from the server's own record of
  // this photo. That is the spike's shortcut, not the destination: the desktop build should
  // read the library directly rather than asking a server for where a file is.
  const located = await fetch(`/api/photos/${photoId}`).then((r) => r.json());
  const settings = await fetch('/api/settings').then((r) => r.json());
  const reply = await invoke('prepare_edit', {
    request: JSON.stringify({
      rawFilePath: located.file_path,
      longEdge: Math.round(longEdge),
      grade: {
        peakNits: settings.hdr_peak_nits,
        referenceWhiteNits: settings.hdr_reference_white_nits,
        whiteQuantile: settings.hdr_white_quantile,
      },
      strengths: {
        luma: settings.raw_denoise_luma,
        chroma: settings.raw_denoise_chroma,
        sharpen: settings.raw_sharpen,
        defringe: settings.raw_defringe,
      },
    }),
  });
  return split(new Uint8Array(reply));
}

async function overHttp(
  photoId: string,
  longEdge: number,
): Promise<{ header: PreparedHeader; samples: Uint16Array<ArrayBuffer> }> {
  const response = await fetch(preparedUrl(photoId, longEdge), { cache: 'no-store' });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`the server could not open this RAW: ${response.status} ${detail.slice(0, 200)}`);
  }
  // In a header rather than the body, so the samples read straight into a texture upload
  // without slicing a JSON prelude off the front of a buffer that is tens of megabytes.
  const described = response.headers.get('X-Prepared');
  if (described == null) throw new Error('the prepared frame arrived with no header');
  return { header: JSON.parse(described) as PreparedHeader, samples: new Uint16Array(await response.arrayBuffer()) };
}

/** `edit::encode`'s framing: a u32 header length, the header, then the samples. */
function split(reply: Uint8Array): { header: PreparedHeader; samples: Uint16Array<ArrayBuffer> } {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const length = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(reply.subarray(4, 4 + length)));
  if (header.ok === false) throw new Error(header.error ?? 'the shell could not open this RAW');
  // Copied rather than viewed: the samples start at a header-dependent offset, which is
  // almost never the alignment a `Uint16Array` over the same buffer needs.
  const samples = new Uint16Array(header.samplesLen / 2);
  new Uint8Array(samples.buffer).set(reply.subarray(4 + length, 4 + length + header.samplesLen));
  return { header: header as PreparedHeader, samples };
}

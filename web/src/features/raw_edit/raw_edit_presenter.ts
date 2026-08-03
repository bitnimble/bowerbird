import { action } from 'mobx';
import { preparedUrl } from '../../api/client';
import { describe } from '../../errors';
import { TickPipeline, type PreparedHeader } from './gpu/tick_pipeline';
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
    this.canvas = canvas;
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
      const device = await adapter.requestDevice();
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
      canvas.width = header.width;
      canvas.height = header.height;
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
      this.request(this.store.exposureEv);
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
   * outstanding, which is what the worker's `busy` flag used to do.
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
      this.pipeline.render(next);
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
  }

  @action.bound
  private fail(message: string): void {
    this.store.status = 'failed';
    this.store.message = message;
  }
}

/**
 * The prepared frame, header and all.
 *
 * The header rides in a response header rather than in the body, so the samples can be
 * read straight into a texture upload without slicing a JSON prelude off the front of a
 * buffer that is tens of megabytes.
 */
async function fetchPrepared(
  photoId: string,
  longEdge: number,
): Promise<{ header: PreparedHeader; samples: Uint16Array }> {
  const response = await fetch(preparedUrl(photoId, longEdge), { cache: 'no-store' });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`the server could not open this RAW: ${response.status} ${detail.slice(0, 200)}`);
  }
  const described = response.headers.get('X-Prepared');
  if (described == null) throw new Error('the prepared frame arrived with no header');
  const header = JSON.parse(described) as PreparedHeader;
  return { header, samples: new Uint16Array(await response.arrayBuffer()) };
}

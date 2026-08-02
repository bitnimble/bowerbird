import type { FromWorker, ToWorker } from './raw_edit_worker';

export type PipelineState = {
  status: 'idle' | 'fetching' | 'decoding' | 'live' | 'failed';
  message: string;
  width: number;
  height: number;
  decodeMs: number;
  gradeMs: number;
  /** Frames actually delivered per second, which is what the drag feels like. */
  fps: number;
  /** Whether the camera's own colour is in play, or the grade fell back to neutral. */
  matched: boolean;
};

const IDLE: PipelineState = {
  status: 'idle',
  message: '',
  width: 0,
  height: 0,
  decodeMs: 0,
  gradeMs: 0,
  fps: 0,
  matched: false,
};

/// Frames are timestamped in microseconds. Nothing plays this back, but a track whose
/// timestamps do not advance is one the compositor is entitled to drop.
const FRAME_INTERVAL_US = 1e6 / 60;

type ExposureRequest = { ev: number; exact: boolean };

/**
 * Whether this browser will build a 10-bit `VideoFrame`.
 *
 * Measured rather than read off a spec, because the spec is wrong in both directions:
 * `VideoPixelFormat` does not list `I420P10` and Chromium accepts it anyway, while
 * Safari 26.4 and Firefox reject every 10-bit format there is (WebKit validates I420 and
 * NV12 alone). 8 bits is not a fall back to SDR - the PQ tagging is accepted either way,
 * and Safari composites it to a real HDR panel - only a coarser ladder, which is what the
 * grade's dither is for.
 */
export function supportsTenBit(): boolean {
  try {
    // Two bytes a sample, so this is the smallest legal 10-bit frame.
    new VideoFrame(new Uint8Array(2 * 2 * 2 * 3), {
      format: 'I420P10',
      codedWidth: 2,
      codedHeight: 2,
      timestamp: 0,
    } as unknown as VideoFrameBufferInit).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Drives one RAW through the decode-once, grade-per-tick loop and out to a video track.
 *
 * Not a MobX store or presenter: it owns no domain state, nothing else reads it, and it
 * exists to be measured rather than to be composed with. If the spike becomes a feature
 * this is the thing that splits into the two.
 */
export class RawEditPipeline {
  private readonly worker: Worker;
  /**
   * Set only where the generator has to live on the main thread, which is Chromium: its
   * `MediaStreamTrackGenerator` is a track, and a track crosses to a worker neither by
   * transfer nor by clone. Safari's `VideoTrackGenerator` is worker-only and sends its
   * track back, so this stays null there and `onTrack` fires later.
   */
  private readonly writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private state = IDLE;

  /** The slider has moved but the previous frame has not come back yet. */
  private pending: ExposureRequest | null = null;
  private busy = false;
  private timestamp = 0;
  private windowStarted = 0;
  private windowFrames = 0;

  constructor(
    private readonly onChange: (state: PipelineState) => void,
    /** Fires once the track exists, whichever side built it. */
    private readonly onTrack: (track: MediaStreamTrack) => void,
  ) {
    if (typeof MediaStreamTrackGenerator !== 'undefined') {
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      this.writer = generator.writable.getWriter();
      this.onTrack(generator);
    }
    this.worker = new Worker(new URL('./raw_edit_worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.receive;
  }

  async open(path: string, block: number): Promise<void> {
    this.update({ ...IDLE, status: 'fetching', message: 'fetching the RAW' });
    const response = await fetch(`/api/raw-edit/raw?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const detail =
        body != null && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText;
      this.update({ ...IDLE, status: 'failed', message: detail });
      return;
    }

    const bytes = await response.arrayBuffer();
    this.update({ ...this.state, status: 'decoding', message: `decoding ${(bytes.byteLength / 1e6).toFixed(1)}MB` });
    this.send({ type: 'open', bytes, longEdge: block, tenBit: supportsTenBit() }, [bytes]);
  }

  /**
   * Asks for a new frame at `ev` stops.
   *
   * Coalescing rather than queueing, because a pointer drag emits far more positions
   * than the grade can serve: queueing them would play the drag back in slow motion
   * after the user let go. Only the latest position is ever outstanding.
   */
  previewExposure(ev: number): void {
    this.requestExposure({ ev, exact: false });
  }

  settleExposure(ev: number): void {
    this.requestExposure({ ev, exact: true });
  }

  private requestExposure(request: ExposureRequest): void {
    if (this.busy) {
      this.pending = request;
      return;
    }
    this.busy = true;
    this.timestamp += FRAME_INTERVAL_US;
    this.send({ type: 'grade', ...request, timestamp: this.timestamp });
  }

  close(): void {
    this.worker.terminate();
    void this.writer?.close().catch(() => undefined);
  }

  private readonly receive = async ({ data }: MessageEvent<FromWorker>): Promise<void> => {
    if (data.type === 'failed') {
      this.busy = false;
      this.update({ ...this.state, status: 'failed', message: data.message });
      return;
    }

    if (data.type === 'track') {
      this.onTrack(data.track);
      return;
    }

    if (data.type === 'opened') {
      this.update({
        ...this.state,
        status: 'live',
        message: '',
        width: data.width,
        height: data.height,
        decodeMs: Math.round(data.ms),
        matched: data.matched,
      });
      this.settleExposure(0);
      return;
    }

    // Null where the worker owns the generator and has already written it.
    if (data.frame != null) await this.writer?.write(data.frame);
    this.measure(data.ms);

    this.busy = false;
    if (this.pending != null) {
      const next = this.pending;
      this.pending = null;
      this.requestExposure(next);
    }
  };

  /** Delivered frames over a rolling second, alongside the grade's own cost. */
  private measure(gradeMs: number): void {
    const now = performance.now();
    this.windowFrames += 1;
    if (this.windowStarted === 0) this.windowStarted = now;

    const elapsed = now - this.windowStarted;
    if (elapsed < 500) {
      this.update({ ...this.state, gradeMs: Math.round(gradeMs) });
      return;
    }
    this.update({
      ...this.state,
      gradeMs: Math.round(gradeMs),
      fps: Math.round((this.windowFrames / elapsed) * 1000),
    });
    this.windowStarted = now;
    this.windowFrames = 0;
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private update(state: PipelineState): void {
    this.state = state;
    this.onChange(state);
  }
}

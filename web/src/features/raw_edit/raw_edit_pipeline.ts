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
  threads: number;
  /** Whether the camera's own colour is in play, or the grade fell back to neutral. */
  matched: boolean;
  /** Object URL of the latest graded PNG, on the still route. Empty on the video one. */
  stillUrl: string;
  /** Object URL of the two-patch PQ reference, once the worker has built it. */
  referenceUrl: string;
};

const IDLE: PipelineState = {
  status: 'idle',
  message: '',
  width: 0,
  height: 0,
  decodeMs: 0,
  gradeMs: 0,
  fps: 0,
  threads: 0,
  matched: false,
  stillUrl: '',
  referenceUrl: '',
};

/// Frames are timestamped in microseconds. Nothing plays this back, but a track whose
/// timestamps do not advance is one the compositor is entitled to drop.
const FRAME_INTERVAL_US = 1e6 / 60;

type ExposureRequest = { ev: number; exact: boolean };

/**
 * Whether this browser will build a 10-bit `VideoFrame`.
 *
 * Measured rather than read off a spec, because the spec is wrong in both directions:
 * `VideoPixelFormat` lists neither `I444P10` nor `I420P10` and Chromium accepts both,
 * while Safari 26.4 and Firefox reject every 10-bit format there is (WebKit validates I420 and
 * NV12 alone). 8 bits is not a fall back to SDR - the PQ tagging is accepted either way,
 * and Safari composites it to a real HDR panel - only a coarser ladder, which is what the
 * grade's dither is for.
 */
export function supportsTenBit(): boolean {
  try {
    // Two bytes a sample and three full-resolution planes, so this is the smallest legal
    // frame in the format the video route packs.
    new VideoFrame(new Uint8Array(2 * 2 * 3 * 2), {
      format: 'I444P10',
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
 * Whether this browser should take the still route rather than a video track.
 *
 * The same measurement decides both, because they are the same limit. A browser that
 * refuses a 10-bit `VideoFrame` can only put an 8-bit one on a track, and Apple's
 * guidance for the layer behind a `MediaStream` is that sample buffers need 10 bits or
 * more to reach EDR - so on WebKit the PQ tag is accepted, then tone-mapped, and an XDR
 * panel shows a washed-out picture rather than an HDR one. A PNG goes through Core
 * Graphics, which has no bit-depth floor and reads CICP, and it carries 16 bits.
 */
export function prefersStill(): boolean {
  return !supportsTenBit();
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
  /**
   * The URL one generation back, revoked only once a newer one has replaced it on the
   * element. Revoking the URL a loaded `<img>` still points at is safe until anything
   * asks it to re-fetch, and holding one generation costs a frame.
   */
  private stale = '';

  constructor(
    private readonly onChange: (state: PipelineState) => void,
    /** Fires once the track exists, whichever side built it. Never on the still route. */
    private readonly onTrack: (track: MediaStreamTrack) => void,
    private readonly still: boolean,
  ) {
    if (!still && typeof MediaStreamTrackGenerator !== 'undefined') {
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      this.writer = generator.writable.getWriter();
      this.onTrack(generator);
    }
    this.worker = new Worker(new URL('./raw_edit_worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.receive;
  }

  async open(path: string, block: number): Promise<void> {
    const kept = { threads: this.state.threads, referenceUrl: this.state.referenceUrl };
    this.update({ ...IDLE, ...kept, status: 'fetching', message: 'fetching the RAW' });
    const response = await fetch(`/api/raw-edit/raw?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const detail =
        body != null && typeof body === 'object' && 'error' in body ? String(body.error) : response.statusText;
      this.update({ ...IDLE, ...kept, status: 'failed', message: detail });
      return;
    }

    const bytes = await response.arrayBuffer();
    this.update({ ...this.state, status: 'decoding', message: `decoding ${(bytes.byteLength / 1e6).toFixed(1)}MB` });
    this.send(
      { type: 'open', bytes, longEdge: block, tenBit: supportsTenBit(), still: this.still },
      [bytes],
    );
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
    for (const url of [this.stale, this.state.stillUrl, this.state.referenceUrl]) {
      if (url !== '') URL.revokeObjectURL(url);
    }
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

    if (data.type === 'ready') {
      this.update({
        ...this.state,
        threads: data.threads,
        referenceUrl: URL.createObjectURL(data.reference),
      });
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
    if (data.still != null) await this.present(data.still);
    this.measure(data.ms);

    this.busy = false;
    if (this.pending != null) {
      const next = this.pending;
      this.pending = null;
      this.requestExposure(next);
    }
  };

  /**
   * Swaps in a newly graded still, decoded before it is shown.
   *
   * Awaited rather than left to the element, so a drag never flashes an empty stage
   * between frames. It also holds `busy` open across the decode, so the delivered-fps
   * figure counts what the drag actually feels like - the `Grade` number is the worker's
   * own and covers the grade and the encode alone.
   *
   * **This is where the still route's memory goes, and no page can get it back.** A URL
   * per tick is a decode per tick, and Chromium holds those in `cc::ImageDecodeCache`
   * outside the JS heap: a six-second drag at 1920 adds ~500MB that a forced major GC
   * does not touch. It is a cache and not a leak - four times the drag grows it 1.5x, and
   * a critical memory-pressure notification hands ~330MB straight back - but every lever
   * that returns it belongs to the browser rather than to script. Measured, and all
   * within noise of doing nothing: revoking sooner, reusing one `Image` across ticks
   * (the cache is keyed by URL and there is a new one every tick), blanking the decoded
   * element's `src`, and freezing the page. The pressure notification is DevTools
   * protocol only, and the API that would have exposed it to a page is an archived WICG
   * proposal. Explicit lifetimes exist just once, on `ImageDecoder` and `close()` - which
   * decodes to a `VideoFrame`, so it is the route this one is the fallback for.
   */
  private async present(png: Blob): Promise<void> {
    const url = URL.createObjectURL(png);
    const image = new Image();
    image.src = url;
    const decoded = await image.decode().then(
      () => true,
      () => false,
    );
    // Keeping the last good frame beats swapping to a broken one, but silently is how a
    // malformed encoder ships: this is the only place a bad PNG would ever show up.
    if (!decoded) {
      URL.revokeObjectURL(url);
      this.update({ ...this.state, status: 'failed', message: 'the graded PNG did not decode' });
      return;
    }

    const previous = this.state.stillUrl;
    this.update({ ...this.state, stillUrl: url });
    if (this.stale !== '') URL.revokeObjectURL(this.stale);
    this.stale = previous;
  }

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

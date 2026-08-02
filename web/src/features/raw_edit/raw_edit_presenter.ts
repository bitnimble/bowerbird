import { action } from 'mobx';
import { api, apiError, downloadUrl } from '../../api/client';
import { describe } from '../../errors';
import { editorSpec } from './editor_spec';
import { sinkFor } from './raw_edit_route';
import type { RawEditStore } from './raw_edit_store';
import type { FromWorker, ToWorker } from './raw_edit_worker';

/// Frames are timestamped in microseconds. Nothing plays this back, but a track whose
/// timestamps do not advance is one the compositor is entitled to drop.
const FRAME_INTERVAL_US = 1e6 / 60;

type ExposureRequest = { ev: number; exact: boolean };

/**
 * Drives one RAW through the decode-once, grade-per-tick loop and out to its route.
 *
 * Owns the worker, the track and every object URL the stage has held, because all three
 * are things that have to be given back and none of them are state a view can own. The
 * store is what the view reads; nothing outside here writes it.
 */
export class RawEditPresenter {
  private readonly worker: Worker;
  /**
   * Set only where the generator has to live on the main thread, which is Chromium: its
   * `MediaStreamTrackGenerator` is a track, and a track crosses to a worker neither by
   * transfer nor by clone. Safari's `VideoTrackGenerator` is worker-only and sends its
   * track back, so this stays null there and the track arrives by message.
   */
  private readonly writer: WritableStreamDefaultWriter<VideoFrame> | null = null;

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

  constructor(private readonly store: RawEditStore) {
    if (store.route === 'track' && typeof MediaStreamTrackGenerator !== 'undefined') {
      const generator = new MediaStreamTrackGenerator({ kind: 'video' });
      this.writer = generator.writable.getWriter();
      this.takeTrack(generator);
    }
    this.worker = new Worker(new URL('./raw_edit_worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = this.receive;
  }

  /**
   * Opens the RAW behind `photoId` and grades it at `longEdge` pixels on its long edge.
   *
   * The bytes come down the route every other stored file takes - by photo id, through
   * the library the photo belongs to - rather than by filesystem path. An editor is not
   * a reason for a second way to read a file off this machine.
   *
   * Never rejects. Both callers fire this and forget it, so anything that escaped would
   * reach the console and leave the page sitting at "loading" with no reason given.
   */
  async open(photoId: string, longEdge: number): Promise<void> {
    this.begin();
    try {
      // The grade's settings alongside the pixels: the editor has to anchor where the
      // renditions do, or the viewer and the file it produces disagree.
      const [settings, response] = await Promise.all([
        api.getSettings(),
        // Uncached, because the HTTP cache can only lose here: the bytes are read once
        // into a buffer that is then transferred away, and re-opening the file re-fetches
        // it regardless. Storing tens of megabytes per open evicts the renditions the
        // library page does want cached, and Chromium fails the whole request with
        // ERR_CACHE_WRITE_FAILURE when the write does not land - the editor then sits
        // dead on a file the server served perfectly.
        fetch(downloadUrl(photoId, 'original'), { cache: 'no-store' }),
      ]);
      if (!response.ok) {
        this.fail((await apiError(response)).message);
        return;
      }

      const bytes = await response.arrayBuffer();
      this.decoding(bytes.byteLength);
      const spec = editorSpec(settings, longEdge, sinkFor(this.store.route));
      this.send({ type: 'open', bytes, spec }, [bytes]);
    } catch (error) {
      this.fail(describe(error));
    }
  }

  /**
   * Asks for a new frame at `ev` stops while the slider is moving.
   *
   * Coalescing rather than queueing, because a pointer drag emits far more positions
   * than the grade can serve: queueing them would play the drag back in slow motion
   * after the user let go. Only the latest position is ever outstanding.
   */
  @action.bound
  previewExposure(ev: number): void {
    this.store.exposureEv = ev;
    this.request({ ev, exact: false });
  }

  /** The frame that gets judged, at full resolution. */
  @action.bound
  settleExposure(ev: number): void {
    this.store.exposureEv = ev;
    this.request({ ev, exact: true });
  }

  close(): void {
    this.worker.terminate();
    void this.writer?.close().catch(() => undefined);
    for (const url of [this.stale, this.store.fileUrl]) {
      if (url !== '') URL.revokeObjectURL(url);
    }
  }

  private request(request: ExposureRequest): void {
    if (this.busy) {
      this.pending = request;
      return;
    }
    this.busy = true;
    this.timestamp += FRAME_INTERVAL_US;
    this.send({ type: 'grade', ...request, timestamp: this.timestamp });
  }

  private readonly receive = async ({ data }: MessageEvent<FromWorker>): Promise<void> => {
    if (data.type === 'failed') {
      this.busy = false;
      this.fail(data.message);
      return;
    }
    if (data.type === 'track') {
      this.takeTrack(data.track);
      return;
    }
    if (data.type === 'ready') {
      this.ready(data.threads);
      return;
    }
    if (data.type === 'opened') {
      this.opened(data.width, data.height, data.ms, data.matched);
      this.settleExposure(0);
      return;
    }

    // Null where the worker owns the generator and has already written it.
    if (data.frame != null) await this.writer?.write(data.frame);
    if (data.file != null) await this.present(data.file);
    this.measure(data.ms);

    this.busy = false;
    if (this.pending != null) {
      const next = this.pending;
      this.pending = null;
      this.request(next);
    }
  };

  /**
   * Swaps in a newly graded file.
   *
   * The still route decodes off-screen first so a drag never flashes an empty stage, and
   * so `busy` covers what the drag feels like. The rewrap does not: it is the same
   * hand-off the photo viewer makes with `avif-hdr-video` - blob URL onto a `<video>` -
   * and Gecko on Linux often never fires `loadeddata` for a 10-bit AV1 sample (HDR
   * compositing itself is Windows-only, DESIGN 10.7). Waiting for a probe there hangs
   * the editor on a platform that was never going to light the panel; the encode is the
   * cost, and the stage element is the decoder.
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
  private async present(file: Blob): Promise<void> {
    const url = URL.createObjectURL(file);
    if (this.store.route === 'rewrap') {
      this.show(url);
      return;
    }
    const decoded = await this.decodeStill(url);
    // Keeping the last good frame beats swapping to a broken one, but silently is how a
    // malformed encoder ships: this is the only place a bad file would ever show up.
    if (!decoded) {
      URL.revokeObjectURL(url);
      this.fail(`the graded ${file.type} did not decode`);
      return;
    }
    this.show(url);
  }

  /** Whether the browser could read the still, off screen, before it is put on screen. */
  private decodeStill(url: string): Promise<boolean> {
    const image = new Image();
    image.src = url;
    return image.decode().then(
      () => true,
      () => false,
    );
  }

  /** Delivered frames over a rolling half-second, alongside the grade's own cost. */
  @action.bound
  private measure(gradeMs: number): void {
    const now = performance.now();
    this.windowFrames += 1;
    if (this.windowStarted === 0) this.windowStarted = now;

    this.store.gradeMs = Math.round(gradeMs);
    const elapsed = now - this.windowStarted;
    if (elapsed < 500) return;
    this.store.fps = Math.round((this.windowFrames / elapsed) * 1000);
    this.windowStarted = now;
    this.windowFrames = 0;
  }

  @action.bound
  private show(url: string): void {
    const previous = this.store.fileUrl;
    this.store.fileUrl = url;
    if (this.stale !== '') URL.revokeObjectURL(this.stale);
    this.stale = previous;
  }

  @action.bound
  private takeTrack(track: MediaStreamTrack): void {
    this.store.track = track;
  }

  @action.bound
  private ready(threads: number): void {
    this.store.threads = threads;
  }

  @action.bound
  private begin(): void {
    this.store.status = 'fetching';
    this.store.message = 'fetching the RAW';
    this.store.width = 0;
    this.store.height = 0;
    this.store.exposureEv = 0;
    this.store.matched = false;
    this.store.decodeMs = 0;
    this.store.gradeMs = 0;
    this.store.fps = 0;
  }

  @action.bound
  private decoding(bytes: number): void {
    this.store.status = 'decoding';
    this.store.message = `decoding ${(bytes / 1e6).toFixed(1)}MB`;
  }

  @action.bound
  private opened(width: number, height: number, ms: number, matched: boolean): void {
    this.store.status = 'live';
    this.store.message = '';
    this.store.width = width;
    this.store.height = height;
    this.store.decodeMs = Math.round(ms);
    this.store.matched = matched;
  }

  @action.bound
  private fail(message: string): void {
    this.store.status = 'failed';
    this.store.message = message;
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }
}

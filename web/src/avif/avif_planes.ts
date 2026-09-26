import { avifPlanesUrl } from '../../../native/rawshim/pkg/avif_planes';

/** `crate::planes::Layout`: where each plane is in the samples, in bytes. */
export interface PlanesLayout {
  width: number;
  height: number;
  bits: 10 | 12;
  subsampled: boolean;
  planes: { offset: number; stride: number }[];
}

/**
 * A picture as planar PQ samples, which is what `VideoFrame.copyTo` hands back where there is an
 * `ImageDecoder` and what `native/avif_planes` hands back where there is not.
 */
export interface PlanarPicture {
  samples: Uint8Array;
  layout: PlanesLayout;
}

export type DecodeAsk =
  | { id: number; file: Uint8Array; urgent: boolean }
  | { id: number; cancel: true }
  | { id: number; promote: true };

export interface DecodeOptions {
  signal?: AbortSignal;
  /** The photo on screen, which goes ahead of every neighbour decoded in case it is next. */
  urgent?: boolean;
  /** Settles when a neighbour becomes the photo on screen while it waits. */
  promoted?: Promise<void>;
  /** The picture's size, if known: past `TEARDOWN_PIXELS`, an abort stops a decode already running. */
  pixels?: number;
}

export type DecodeAnswer =
  | { id: number; planes: PlanarPicture }
  | { id: number; declined: string }
  | { id: number; failed: string };

/** What the decoder's worker sends back: that a decode has begun, or how it ended. */
export type DecodeReply = DecodeAnswer | { id: number; started: true };

/** A decoder worker's first message: the module, compiled once for every worker the page starts. */
export type DecoderStart = { module: WebAssembly.Module };

/** Past this, an abort tears the decoder down rather than waiting out a decode already running. */
const TEARDOWN_PIXELS = 20_000_000;

/**
 * Whether this page can run the decoder: its threads share memory, which a browser allows only a
 * cross-origin isolated page (`COOP`/`COEP`, set where the app is served).
 */
export function canDecodeAvifPlanes(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
}

interface Pending {
  file: Uint8Array;
  urgent: boolean;
  large: boolean;
  settle: (answer: DecodeAnswer) => void;
}

/**
 * The AV1 decoder, on a worker of its own and started on first use.
 *
 * A worker rather than this thread because a decode waits on its threads with `Atomics.wait`, which
 * a page's main thread may not do.
 */
class AvifPlanes {
  // Here, once, not in the worker: one started after a teardown would compile the module afresh.
  private readonly module = WebAssembly.compileStreaming(fetch(avifPlanesUrl));
  private readonly pending = new Map<number, Pending>();
  private worker = this.start();
  private running: number | null = null;
  private asked = 0;
  private uncompiled = false;

  /**
   * Null for a picture the planar draw does not read, one that would not decode, and one aborted.
   * An abort takes a waiting decode off the queue, and stops a running one only if it is large.
   */
  async decode(file: Uint8Array, { signal, urgent = true, promoted, pixels = 0 }: DecodeOptions): Promise<PlanarPicture | null> {
    // Nothing would ever start the worker, so the ask would wait forever.
    if (this.uncompiled) return null;
    // An abort already past fires no event, so it is never cancelled.
    if (signal?.aborted === true) return null;
    const id = ++this.asked;
    const answer = await new Promise<DecodeAnswer>((settle) => {
      this.pending.set(id, { file, urgent, large: pixels > TEARDOWN_PIXELS, settle });
      this.worker.postMessage({ id, file, urgent } satisfies DecodeAsk);
      signal?.addEventListener('abort', () => this.cancel(id), { once: true });
      void promoted?.then(() => this.promote(id));
    });
    if ('planes' in answer) return answer.planes;
    if ('failed' in answer) console.warn(`avif_planes: ${answer.failed}`);
    return null;
  }

  private start(): Worker {
    const worker = new Worker(new URL('./avif_worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<DecodeReply>) => {
      const reply = event.data;
      if ('started' in reply) {
        this.running = reply.id;
        return;
      }
      if (this.running === reply.id) this.running = null;
      this.settle(reply);
    };
    // Replaced as well as reported: every later ask posted to a dead worker would wait forever.
    worker.onerror = (event) => {
      this.fail(event.message);
      worker.terminate();
      if (this.worker === worker) this.worker = this.start();
    };
    this.module.then(
      (module) => worker.postMessage({ module } satisfies DecoderStart),
      (err: unknown) => {
        this.uncompiled = true;
        this.fail(`the decoder would not compile: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return worker;
  }

  private fail(why: string): void {
    for (const id of this.pending.keys()) this.settle({ id, failed: why });
  }

  private cancel(id: number): void {
    const asked = this.pending.get(id);
    if (asked == null) return;
    if (this.running === id && asked.large) this.restart(id);
    else this.worker.postMessage({ id, cancel: true } satisfies DecodeAsk);
  }

  private promote(id: number): void {
    const asked = this.pending.get(id);
    if (asked == null) return;
    asked.urgent = true;
    this.worker.postMessage({ id, promote: true } satisfies DecodeAsk);
  }

  /**
   * A fresh decoder in place of one busy with a picture nobody wants: terminating its worker takes
   * the thread pool and the shared memory with it. Everything still waiting is asked again.
   */
  private restart(cancelled: number): void {
    this.worker.terminate();
    this.running = null;
    this.settle({ id: cancelled, declined: 'cancelled' });
    this.worker = this.start();
    for (const [id, { file, urgent }] of this.pending) this.worker.postMessage({ id, file, urgent } satisfies DecodeAsk);
  }

  private settle(answer: DecodeAnswer): void {
    this.pending.get(answer.id)?.settle(answer);
    this.pending.delete(answer.id);
  }
}

let started: AvifPlanes | null = null;

export function decodeAvifPlanes(file: Uint8Array, options: DecodeOptions = {}): Promise<PlanarPicture | null> {
  started ??= new AvifPlanes();
  return started.decode(file, options);
}

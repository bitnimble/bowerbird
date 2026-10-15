import { vp9FrameToMp4 } from 'avif-hdr-video';
import { vp9EncodeUrl } from '../../../native/rawshim/pkg/vp9_encode';
import { pageLog } from '../features/logs/page_log';
import type { ModuleStart } from '../wasi/thread_pool';

/**
 * A picture as `pq420.slang` writes it: 10-bit samples, luma then the two chroma
 * planes, each a row of its stride after another, every offset and stride in samples.
 */
export interface Pq420Frame {
  samples: Uint16Array;
  width: number;
  height: number;
  lumaStride: number;
  chromaStride: number;
  cbOffset: number;
  crOffset: number;
}

export const VIDEO_SURFACES = ['stage', 'loupe', 'wheel'] as const;
export type VideoSurface = (typeof VIDEO_SURFACES)[number];

/** `gpu::Pq420Layout::header`'s length. */
const HEADER_WORDS = 8;

function pq420FrameOf(bytes: Uint8Array<ArrayBuffer>): Pq420Frame {
  const header = new Uint32Array(bytes.buffer, bytes.byteOffset, HEADER_WORDS);
  const [width = 0, height = 0, lumaStride = 0, chromaStride = 0, cbOffset = 0, crOffset = 0] =
    header;
  const at = bytes.byteOffset + HEADER_WORDS * 4;
  return {
    samples: new Uint16Array(bytes.buffer, at, (bytes.byteLength - HEADER_WORDS * 4) / 2),
    width,
    height,
    lumaStride,
    chromaStride,
    cbOffset,
    crOffset,
  };
}

export type EncodeAsk = { id: number; surface: VideoSurface; frame: Pq420Frame };
export type EncodeAnswer = { id: number; coded: Uint8Array } | { id: number; failed: string };

/**
 * The editor's VP9 encoder on Firefox (`native/vp9_encode`), on a worker of its own, started on
 * first use and stopped by {@link close}.
 */
class Vp9Encoder {
  private module: Promise<WebAssembly.Module> | null = null;
  private worker: Worker | null = null;
  private readonly pending = new Map<number, (answer: EncodeAnswer) => void>();
  private asked = 0;

  /**
   * `bytes`, `Gpu::pq420`'s answer, as a one-frame MP4 of a VP9 keyframe. Their buffer is handed
   * to the worker.
   */
  async encode(
    surface: VideoSurface,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const frame = pq420FrameOf(bytes);
    const worker = this.started();
    const id = ++this.asked;
    const answer = await new Promise<EncodeAnswer>((settle) => {
      this.pending.set(id, settle);
      try {
        worker.postMessage({ id, surface, frame } satisfies EncodeAsk, [frame.samples.buffer]);
      } catch (err) {
        this.pending.delete(id);
        settle({ id, failed: err instanceof Error ? err.message : String(err) });
      }
    });
    if ('failed' in answer) throw new Error(answer.failed);
    return vp9FrameToMp4(answer.coded, frame.width, frame.height);
  }

  /** Stops the worker, and the threads and memory it holds; the next encode starts another. */
  close(): void {
    if (this.worker != null) this.stop(this.worker, 'the encoder was closed');
  }

  private started(): Worker {
    if (this.worker != null) return this.worker;
    this.module ??= WebAssembly.compileStreaming(fetch(vp9EncodeUrl));
    const worker = pageLog.adopted(
      new Worker(new URL('./vp9_worker.ts', import.meta.url), { type: 'module' }),
    );
    worker.onmessage = (event: MessageEvent<EncodeAnswer>) => {
      this.pending.get(event.data.id)?.(event.data);
      this.pending.delete(event.data.id);
    };
    worker.onerror = (event) => this.stop(worker, event.message);
    this.module.then(
      (module) => worker.postMessage({ module } satisfies ModuleStart),
      (err: unknown) => {
        this.module = null;
        this.stop(
          worker,
          `the encoder would not compile: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
    this.worker = worker;
    return worker;
  }

  private stop(worker: Worker, why: string): void {
    worker.terminate();
    if (this.worker === worker) this.worker = null;
    this.fail(why);
  }

  private fail(why: string): void {
    for (const [id, settle] of this.pending) settle({ id, failed: why });
    this.pending.clear();
  }
}

export const vp9Encoder = new Vp9Encoder();

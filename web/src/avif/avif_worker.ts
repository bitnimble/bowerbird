// The AVIF decoder's own thread (`avif_planes.ts`): an instance of the module, its memory, and the
// pool its threads run on.

import type { DecodeAnswer, DecodeAsk, DecodeReply, DecoderStart, PlanesLayout } from './avif_planes';
import { ThreadPool } from './avif_pool';
import { wasiImports } from './wasi';

/** Past eight, a still decodes no faster and each thread holds its own buffers. */
const MAX_THREADS = 8;
/** The module's own `--max-memory`, in 64KiB pages. */
const MAX_PAGES = 16384;
const ANSWER_WORDS = 13;

interface Exports {
  __wasi_init_tp(): void;
  __wasm_call_ctors(): void;
  avif_planes_alloc(length: number): number;
  avif_planes_free(at: number, length: number): void;
  avif_planes_decode(file: number, length: number, threads: number, out: number): void;
  avif_planes_release(): void;
}

class Decoder {
  private constructor(
    private readonly exports: Exports,
    private readonly memory: WebAssembly.Memory,
    private readonly threads: number,
  ) {}

  static async open(module: WebAssembly.Module): Promise<Decoder> {
    const threads = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, MAX_THREADS));
    const memory = new WebAssembly.Memory({ initial: 256, maximum: MAX_PAGES, shared: true });
    const pool = await ThreadPool.start(module, memory, threads);
    const instance = await WebAssembly.instantiate(module, wasiImports(memory, pool.spawn));
    const exports = instance.exports as unknown as Exports;
    // What a reactor's `_initialize` would run, which this module does not link.
    exports.__wasi_init_tp();
    exports.__wasm_call_ctors();
    return new Decoder(exports, memory, threads);
  }

  decode({ id, file }: Queued): DecodeAnswer {
    const { exports } = this;
    const at = exports.avif_planes_alloc(file.length);
    const out = exports.avif_planes_alloc(ANSWER_WORDS * 4);
    try {
      new Uint8Array(this.memory.buffer, at, file.length).set(file);
      exports.avif_planes_decode(at, file.length, this.threads, out);
      const view = new DataView(this.memory.buffer);
      const word = (index: number): number => view.getUint32(out + index * 4, true);
      const bytes = new Uint8Array(this.memory.buffer, word(1), word(2));
      if (word(0) !== 0) {
        const reason = new TextDecoder().decode(bytes.slice());
        return word(0) === 1 ? { id, declined: reason } : { id, failed: reason };
      }
      // Into memory of its own, shared so the GPU thread reads it without a copy of its own.
      const samples = new Uint8Array(new SharedArrayBuffer(bytes.length));
      samples.set(bytes);
      const layout: PlanesLayout = {
        width: word(3),
        height: word(4),
        bits: word(5) === 12 ? 12 : 10,
        subsampled: word(6) === 1,
        planes: [0, 1, 2].map((plane) => ({ offset: word(7 + plane * 2), stride: word(8 + plane * 2) })),
      };
      return { id, planes: { samples, layout } };
    } finally {
      exports.avif_planes_release();
      exports.avif_planes_free(at, file.length);
      exports.avif_planes_free(out, ANSWER_WORDS * 4);
    }
  }
}

type Queued = Extract<DecodeAsk, { file: Uint8Array }>;

/**
 * Decodes one at a time, returning to the event loop between them so a cancel sent while one was
 * running takes the next off the queue before it starts.
 */
class Queue {
  private readonly queued: Queued[] = [];
  private running = false;
  private open: (module: WebAssembly.Module) => void = () => {};
  private readonly opened = new Promise<Decoder>((resolve, reject) => {
    this.open = (module) => Decoder.open(module).then(resolve, reject);
  });

  start({ module }: DecoderStart): void {
    this.open(module);
  }

  take(ask: DecodeAsk): void {
    if ('cancel' in ask) {
      const at = this.queued.findIndex((queued) => queued.id === ask.id);
      if (at !== -1) {
        this.queued.splice(at, 1);
        self.postMessage({ id: ask.id, declined: 'cancelled' } satisfies DecodeAnswer);
      }
      return;
    }
    if ('promote' in ask) {
      const at = this.queued.findIndex((queued) => queued.id === ask.id);
      const [promoted] = at === -1 ? [] : this.queued.splice(at, 1);
      if (promoted != null) this.enqueue({ ...promoted, urgent: true });
      return;
    }
    this.enqueue(ask);
    if (!this.running) void this.drain();
  }

  /**
   * The newest urgent decode first: the photo on screen is the last one asked for, and an earlier
   * urgent one is a photo the reader has already left, whose cancel is on its way.
   */
  private enqueue(ask: Queued): void {
    if (ask.urgent) this.queued.unshift(ask);
    else this.queued.push(ask);
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve));
        const ask = this.queued.shift();
        if (ask == null) return;
        let answer: DecodeAnswer;
        try {
          const decoder = await this.opened;
          self.postMessage({ id: ask.id, started: true } satisfies DecodeReply);
          answer = decoder.decode(ask);
        } catch (err) {
          answer = { id: ask.id, failed: err instanceof Error ? err.message : String(err) };
        }
        self.postMessage(answer);
      }
    } finally {
      this.running = false;
    }
  }
}

const queue = new Queue();
self.onmessage = (event: MessageEvent<DecodeAsk | DecoderStart>) => {
  const message = event.data;
  if ('module' in message) queue.start(message);
  else queue.take(message);
};

// The VP9 encoder's own thread (`vp9_encoder.ts`): an instance of the module, its memory, and the
// pool its threads run on.

import {
  VIDEO_SURFACES,
  type EncodeAnswer,
  type EncodeAsk,
  type Pq420Frame,
  type VideoSurface,
} from './vp9_encoder';
import { instantiateThreaded, type ModuleStart, type ThreadedExports } from '../wasi/thread_pool';
import { pageLog } from '../features/logs/page_log';

pageLog.follow('worker');

const LOG_NAME = 'vp9_encode';
const MOST_THREADS: Record<VideoSurface, number> = { stage: 8, loupe: 3, wheel: 2 };
const PIXELS_PER_THREAD = 250_000;
// Every surface's encoder holds its threads while open, and libvpx starts one fewer than it is
// given: fewer workers than this and a spawn waits out its timeout and the encode fails.
const POOL_THREADS = VIDEO_SURFACES.reduce((sum, surface) => sum + MOST_THREADS[surface] - 1, 0);
const ANSWER_WORDS = 3;

interface Exports extends ThreadedExports {
  hdr_video_alloc(length: number): number;
  hdr_video_free(at: number, length: number): void;
  hdr_video_encode(
    surface: number,
    samples: number,
    length: number,
    width: number,
    height: number,
    lumaStride: number,
    chromaStride: number,
    cbOffset: number,
    crOffset: number,
    threads: number,
    out: number,
  ): void;
}

class Encoder {
  private constructor(
    private readonly exports: Exports,
    private readonly memory: WebAssembly.Memory,
    private readonly threads: number,
  ) {}

  static async open(module: WebAssembly.Module): Promise<Encoder> {
    const threads = Math.max(1, navigator.hardwareConcurrency || 4);
    const { exports, memory } = await instantiateThreaded<Exports>(LOG_NAME, module, POOL_THREADS);
    return new Encoder(exports, memory, threads);
  }

  encode(id: number, surface: VideoSurface, frame: Pq420Frame): EncodeAnswer {
    const { exports } = this;
    const bytes = frame.samples.byteLength;
    const threads = Math.min(
      this.threads,
      MOST_THREADS[surface],
      Math.max(1, Math.ceil((frame.width * frame.height) / PIXELS_PER_THREAD)),
    );
    const at = exports.hdr_video_alloc(bytes);
    try {
      const out = exports.hdr_video_alloc(ANSWER_WORDS * 4);
      try {
        new Uint16Array(this.memory.buffer, at, frame.samples.length).set(frame.samples);
        exports.hdr_video_encode(
          VIDEO_SURFACES.indexOf(surface),
          at,
          frame.samples.length,
          frame.width,
          frame.height,
          frame.lumaStride,
          frame.chromaStride,
          frame.cbOffset,
          frame.crOffset,
          threads,
          out,
        );
        const view = new DataView(this.memory.buffer);
        const word = (index: number): number => view.getUint32(out + index * 4, true);
        const answer = new Uint8Array(this.memory.buffer, word(1), word(2)).slice();
        if (word(0) !== 0) return { id, failed: new TextDecoder().decode(answer) };
        return { id, coded: answer };
      } finally {
        exports.hdr_video_free(out, ANSWER_WORDS * 4);
      }
    } finally {
      exports.hdr_video_free(at, bytes);
    }
  }
}

const started = Promise.withResolvers<WebAssembly.Module>();
const opened = started.promise.then(Encoder.open);

self.onmessage = async (event: MessageEvent<EncodeAsk | ModuleStart>) => {
  const message = event.data;
  if ('module' in message) {
    started.resolve(message.module);
    return;
  }
  let answer: EncodeAnswer;
  try {
    answer = (await opened).encode(message.id, message.surface, message.frame);
  } catch (err) {
    answer = { id: message.id, failed: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(answer, 'coded' in answer ? [answer.coded.buffer] : []);
};

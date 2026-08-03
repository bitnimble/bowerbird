/// <reference lib="webworker" />
import { avifToMp4 } from 'avif-hdr-video';
import { describe } from '../../errors';
import init, { Editor, initThreadPool, thread_count } from '../../wasm/rawshim';
import { useMemory } from './wasi_stub';
import type { EditorSpec } from './editor_spec';

// The decode and the grade both run here. On the main thread a 20ms grade would land
// between the slider's pointer events, which is the one place the jank would be blamed on
// the pipeline rather than on the layout.
//
// **Where the track is created depends on the browser, and it cannot be otherwise.**
// Safari implements the standard `VideoTrackGenerator`, which exists only in a worker, and
// hands back a transferable `MediaStreamTrack`. Chromium has the older
// `MediaStreamTrackGenerator`, which is itself a track and - measured - is neither
// transferable nor cloneable, so it has to be built on the main thread and fed frames from
// here. Two paths, no way to unify them.
//
// The two file sinks sidestep both: a PNG or an MP4 needs no track at either end, only a
// blob.

export type ToWorker =
  | { type: 'open'; bytes: ArrayBuffer; spec: EditorSpec }
  | { type: 'grade'; ev: number; exact: boolean; timestamp: number }
  | { type: 'shutdown' };

export type FromWorker =
  | { type: 'ready'; threads: number }
  | { type: 'track'; track: MediaStreamTrack }
  | { type: 'opened'; width: number; height: number; ms: number; matched: boolean }
  // At most one of `frame` and `file` is set, and the blob carries its own type. A frame
  // comes back only when the main thread owns the generator; where this worker owns it,
  // both are null and the message just reports the cost.
  | { type: 'frame'; frame: VideoFrame | null; file: Blob | null; ev: number; ms: number }
  | { type: 'failed'; message: string }
  | { type: 'shutdown' };

let editor: Editor | null = null;
let memory: WebAssembly.Memory | null = null;
let tenBit = true;
let sink: EditorSpec['sink'] = 'video';
/** Set only when this worker owns the generator, which is the Safari video path. */
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
/** Set by shutdown; open/grade and init must not touch the pool after it. */
let shuttingDown = false;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []): void =>
  scope.postMessage(message, transfer);

// wasm-bindgen-rayon spawns one nested Worker per pool thread and never keeps the
// handles. Parent `terminate()` alone is not enough: Chromium can leave those nested
// workers alive, and once the SharedArrayBuffer's other end is gone they spin every
// core. Track constructions so shutdown can kill them first.
const poolWorkers: Worker[] = [];
{
  const globals = globalThis as typeof globalThis & { Worker: typeof Worker };
  const ParentWorker = globals.Worker;
  globals.Worker = class extends ParentWorker {
    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super(scriptURL, options);
      poolWorkers.push(this);
    }
  };
}

type Initialized = { memory: WebAssembly.Memory };

const initialized = initialize();

async function initialize(): Promise<Initialized> {
  const instance = await init();
  useMemory(instance.memory);
  // Shutdown may have won the race during `init()`: skip the pool rather than spawn
  // workers that would outlive a parent about to close.
  if (shuttingDown) return { memory: instance.memory };
  const requested = Math.max(1, navigator.hardwareConcurrency);
  await initThreadPool(requested);
  if (shuttingDown) return { memory: instance.memory };
  post({ type: 'ready', threads: thread_count() });
  return { memory: instance.memory };
}

void initialized.catch((error: unknown) => {
  if (!shuttingDown) post({ type: 'failed', message: describe(error) });
});

const png = (bytes: Uint8Array): Blob =>
  new Blob([bytes.slice() as BlobPart], { type: 'image/png' });

/**
 * The AVIF the editor just encoded, in the container Firefox will composite.
 *
 * An AVIF *is* an AV1 frame, so this copies the OBUs into an MP4 rather than encoding
 * anything - about a millisecond, against the encode that produced them. The same
 * function the photo view rewraps stored renditions with, so there is one implementation
 * of the container trick rather than one per caller (DESIGN 10.7.2).
 *
 * No copy first, unlike the PNG: the rewrap builds its output in a buffer of its own, so
 * what reaches the `Blob` is already off the shared heap.
 */
const clip = (bytes: Uint8Array): Blob =>
  new Blob([avifToMp4(bytes) as BlobPart], { type: 'video/mp4' });

/** Builds a worker-side track where the browser has one, and reports whether it did. */
function openTrack(): boolean {
  const Generator = (self as { VideoTrackGenerator?: new () => VideoTrackGenerator })
    .VideoTrackGenerator;
  if (Generator == null) return false;

  const generator = new Generator();
  writer = generator.writable.getWriter();
  post({ type: 'track', track: generator.track }, [generator.track]);
  return true;
}

scope.onmessage = async ({ data }: MessageEvent<ToWorker>): Promise<void> => {
  try {
    if (data.type === 'shutdown') {
      shuttingDown = true;
      // Wait until every nested worker initThreadPool will create is on the list —
      // killing a partial pool leaves the rest spinning after this worker dies.
      await initialized.catch(() => undefined);
      for (const worker of poolWorkers.splice(0)) worker.terminate();
      void writer?.close().catch(() => undefined);
      writer = null;
      editor = null;
      post({ type: 'shutdown' });
      scope.close();
      return;
    }

    if (shuttingDown) return;

    if (data.type === 'open') {
      memory = (await initialized).memory;
      if (shuttingDown) return;
      tenBit = data.spec.tenBit;
      sink = data.spec.sink;
      if (sink === 'video') openTrack();
      const started = performance.now();
      editor = new Editor(new Uint8Array(data.bytes), JSON.stringify(data.spec));
      const decoded = performance.now() - started;
      if (shuttingDown) {
        editor = null;
        return;
      }
      // The camera's own colour, fitted from its embedded JPEG - decode, resample, solve
      // and all, so the browser fits through the very code the renditions do.
      const matched = editor.fit_camera_match();
      // Unconditional, and only correct here: the fit is the last thing that reads the
      // decode, and every tick after this grades from the prepared frame instead.
      editor.release_source();
      if (shuttingDown) return;
      post({ type: 'opened', width: editor.width, height: editor.height, ms: decoded, matched });
      return;
    }

    if (editor == null || memory == null) throw new Error('graded before the RAW was opened');

    const started = performance.now();
    if (data.exact) editor.grade(data.ev);
    else editor.preview(data.ev);
    if (shuttingDown) return;

    // Rebuilt every tick rather than cached: growing wasm memory detaches every view over
    // it, and a detached one reads as an empty frame rather than throwing.
    const bytes = new Uint8Array(memory.buffer, editor.output_ptr, editor.output_len);

    // Copied out, which the shared memory the thread pool runs on makes necessary as well
    // as prudent: `Blob` will not take a view backed by a `SharedArrayBuffer`.
    if (sink !== 'video') {
      if (bytes.length === 0) throw new Error(`the ${sink} encode produced no bytes`);
      const file = sink === 'still' ? png(bytes) : clip(bytes);
      if (shuttingDown) return;
      post({ type: 'frame', frame: null, file, ev: data.ev, ms: performance.now() - started });
      return;
    }

    // 10-bit where the browser takes it. The 8-bit arm is reachable only by forcing this
    // route onto an engine that refuses 10 bits, and it is a diagnostic rather than a
    // fallback: PQ on 8 bits is tagged the same and composited as HDR by neither of the
    // two engines that reject 10-bit frames (measured - WebKit tone-maps it, Gecko will
    // not composite it at all), so nothing is blessed on this arm.
    const frameInit: HdrVideoFrameBufferInit = {
      format: tenBit ? 'I444P10' : 'I444',
      codedWidth: editor.output_width,
      codedHeight: editor.output_height,
      timestamp: data.timestamp,
      colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
    };
    const frame = new VideoFrame(bytes, frameInit as unknown as VideoFrameBufferInit);

    if (writer != null) {
      await writer.write(frame);
      if (shuttingDown) return;
      post({ type: 'frame', frame: null, file: null, ev: data.ev, ms: performance.now() - started });
      return;
    }
    if (shuttingDown) {
      frame.close();
      return;
    }
    post({ type: 'frame', frame, file: null, ev: data.ev, ms: performance.now() - started }, [frame]);
  } catch (e) {
    if (!shuttingDown) post({ type: 'failed', message: describe(e) });
  }
};

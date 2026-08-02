/// <reference lib="webworker" />
import init, { Editor } from '../../wasm/rawshim';

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

export type ToWorker =
  | { type: 'open'; bytes: ArrayBuffer; longEdge: number; tenBit: boolean }
  | { type: 'grade'; ev: number; exact: boolean; timestamp: number };

export type FromWorker =
  | { type: 'track'; track: MediaStreamTrack }
  | { type: 'opened'; width: number; height: number; ms: number; matched: boolean }
  // The frame comes back only when the main thread owns the generator; otherwise it has
  // already been written here and this just reports the cost.
  | { type: 'frame'; frame: VideoFrame | null; ev: number; ms: number }
  | { type: 'failed'; message: string };

let editor: Editor | null = null;
let memory: WebAssembly.Memory | null = null;
let tenBit = true;
/** Set only when this worker owns the generator, which is the Safari path. */
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []): void =>
  scope.postMessage(message, transfer);

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

/**
 * Decodes the RAW's embedded JPEG and hands the pixels to the fit.
 *
 * The browser's decoder rather than a Rust one, because it has a good one and the
 * alternative is another image codec in the module. Everything downstream - the
 * resample, the blur, the pairing, the solve - is `hdr_fit`, the same code the AVIF
 * renditions fit with, so there is no second implementation to drift.
 *
 * False where the file embeds no preview or the fit found too few usable pairs. That is
 * not an error: the grade falls back to its neutral arm exactly as a rendition does.
 */
async function fitCameraMatch(open: Editor): Promise<boolean> {
  const jpeg = open.preview_jpeg();
  if (jpeg.length === 0) return false;

  // Resized on decode, to the edge the renditions fit at. Not an optimisation: the fit
  // linearises the preview whole into f64 first, and a full-size one is 576MB - more than
  // wasm32 will allocate, which is what made this decline silently.
  const edge = open.preview_edge;
  const probe = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
  const scale = edge / Math.max(probe.width, probe.height);
  const width = Math.max(1, Math.round(probe.width * scale));
  const height = Math.max(1, Math.round(probe.height * scale));

  // Resized through a canvas rather than `createImageBitmap`'s resize options: in a
  // worker those silently produced a 0x0 bitmap here, and the draw is one call anyway.
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context == null) return false;
  context.drawImage(probe, 0, 0, width, height);
  probe.close();
  const bitmap = { width, height };

  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);

  // Canvas only hands back RGBA; the fit wants packed RGB.
  const pixels = bitmap.width * bitmap.height;
  const rgb = new Uint8Array(pixels * 3);
  for (let pixel = 0; pixel < pixels; pixel++) {
    rgb[pixel * 3] = data[pixel * 4] ?? 0;
    rgb[pixel * 3 + 1] = data[pixel * 4 + 1] ?? 0;
    rgb[pixel * 3 + 2] = data[pixel * 4 + 2] ?? 0;
  }
  return open.fit_camera_match(rgb, bitmap.width, bitmap.height);
}

scope.onmessage = async ({ data }: MessageEvent<ToWorker>): Promise<void> => {
  try {
    if (data.type === 'open') {
      memory = (await init()).memory;
      tenBit = data.tenBit;
      openTrack();
      const started = performance.now();
      editor = new Editor(new Uint8Array(data.bytes), data.longEdge, data.tenBit);
      const decoded = performance.now() - started;
      // The camera's own colour, fitted from its embedded JPEG. `hdr_fit` does the
      // resampling and the solve; the browser only decodes, because that is the one step
      // with no pure-Rust path in the module.
      const matched = await fitCameraMatch(editor);
      post({ type: 'opened', width: editor.width, height: editor.height, ms: decoded, matched });
      return;
    }

    if (editor == null || memory == null) throw new Error('graded before the RAW was opened');

    const started = performance.now();
    if (data.exact) editor.grade(data.ev);
    else editor.preview(data.ev);

    // Rebuilt every tick rather than cached: growing wasm memory detaches every view over
    // it, and a detached one reads as an empty frame rather than throwing.
    const planes = new Uint8Array(memory.buffer, editor.planes_ptr, editor.planes_len);
    // 10-bit where the browser takes it, 8-bit where it does not - both tagged PQ, which
    // is what makes the 8-bit path a coarser HDR picture rather than an SDR one.
    const frameInit: HdrVideoFrameBufferInit = {
      format: tenBit ? 'I420P10' : 'I420',
      codedWidth: editor.output_width,
      codedHeight: editor.output_height,
      timestamp: data.timestamp,
      colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
    };
    const frame = new VideoFrame(planes, frameInit as unknown as VideoFrameBufferInit);

    if (writer != null) {
      await writer.write(frame);
      post({ type: 'frame', frame: null, ev: data.ev, ms: performance.now() - started });
      return;
    }
    post({ type: 'frame', frame, ev: data.ev, ms: performance.now() - started }, [frame]);
  } catch (e) {
    post({ type: 'failed', message: e instanceof Error ? e.message : String(e) });
  }
};

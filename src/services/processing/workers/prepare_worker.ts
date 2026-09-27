import { preparePicture } from '../rawshim/rawshim_prepare';
import { writePhotoAnalysis } from '../analysis/photo_analysis_store';
import { toCommand, toCompositeCommand } from '../rawshim/worker_command';
import type { WorkerJob } from './processing_types';

// One picture of a recipe, prepared off the API thread.
//
// Thin on purpose, and that is the difference from `processing_worker`: no output directories and
// no partial files to remove on failure, because a prepare writes no picture. The one thing it
// does write is the analysis, below.

export interface PrepareAsk {
  job: WorkerJob;
  level: number;
  /** What the level will produce, which is what sizes the reply's buffer. */
  width: number;
  height: number;
  /** `[left, top, width, height]` of that level, absent for the whole of it. */
  window?: [number, number, number, number];
  /** The squares inside `window` that were asked for, empty or absent for the whole of it. */
  parts?: [number, number, number, number][];
}

export type PrepareAnswer = { ok: true; framed: Uint8Array } | { ok: false; error: string };

declare const self: {
  onmessage: ((event: MessageEvent<PrepareAsk>) => void) | null;
  postMessage: (message: PrepareAnswer, transfer?: ArrayBuffer[]) => void;
};

self.onmessage = (event: MessageEvent<PrepareAsk>): void => {
  const ask = event.data;
  try {
    const command = ask.job.kind === 'composite' ? toCompositeCommand(ask.job) : toCommand(ask.job);
    const picture = preparePicture(
      command,
      ask.level,
      ask.width,
      ask.height,
      ask.window,
      ask.parts,
    );
    // Kept here, in the worker that measured it, as the rendition worker keeps its own: it is a
    // file, this side is already doing file work, and it is what stops the next open of a
    // composite stacking every source again.
    //
    // A window's too: what it files is the union levels and the reference's balance, which are
    // the canvas's rather than the rectangle's - so a window that had to measure them keeps the
    // next one from measuring them again.
    const measured = picture.header.photoAnalysis;
    if (measured != null) {
      writePhotoAnalysis(ask.job.dataPath, ask.job.photoId, Uint8Array.from(measured));
    }
    // Transferred, not copied: a picture is tens of megabytes, and structured-cloning it would
    // hold two of them for the length of one message.
    self.postMessage({ ok: true, framed: picture.framed }, transferable(picture.framed));
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// `Uint8Array.buffer` is `ArrayBufferLike`, which a transfer list will not take.
function transferable(framed: Uint8Array): ArrayBuffer[] {
  return framed.buffer instanceof ArrayBuffer ? [framed.buffer] : [];
}

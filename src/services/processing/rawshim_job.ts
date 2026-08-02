// One photo's renditions, run by the native library (DESIGN §10.3).
//
// The whole boundary for this path: a command in, a result out, both JSON. Nothing
// here holds an address the library gave it, so there is no handle to free, no
// ordering to get right between calls, and no way for a mistake on this side to
// reach freed memory. The orchestration that used to live in the worker - the lazy
// decodes, the shared base, the release ordering - is in `job.rs`, where the
// compiler can see the lifetimes it depends on.
import { ptr } from 'bun:ffi';
import { shim } from './rawshim';
import type { RenditionSource } from './processing_types';
import type { Rendition } from './renditions';

/** How a scene-linear decode is graded to display-referred (§10.7). */
export interface JobGrade {
  peakNits: number;
  referenceWhiteNits: number;
  whiteQuantile: number;
}

export interface JobTarget {
  rendition: Rendition;
  hdr: boolean;
  outputPath: string;
  /** Longest edge, or 0 for native resolution. */
  size: number;
  source: RenditionSource;
  sdrQuantizer: number;
  hdrQuantizer: number;
  preset: number;
  stillFullChroma: boolean;
  sdrFullChroma: boolean;
}

export interface Job {
  rawFilePath: string;
  matchEmbeddedJpeg: boolean;
  /**
   * The base render, before any rendition of it (§10.9): the two denoise strengths, 1
   * being the tuned default, and how much of a deconvolution to blend in for the
   * sharpen, 0 to 1. All belong to the render rather than to a rendition, so every
   * target shares them, and all are unitless - how much noise the frame has is measured
   * off its own pixels on the far side, not passed in.
   */
  denoiseLuma: number;
  denoiseChroma: number;
  sharpen: number;
  defringe: number;
  grade: JobGrade;
  targets: JobTarget[];
}

export interface JobOutcome {
  /** The stacking descriptor a grid tile produced (§19.3), or undefined. */
  descriptor?: Uint8Array;
}

interface JobReply {
  ok: boolean;
  error?: string;
  outcome?: { descriptor?: number[] };
}

// Big enough for any reply the job produces: the only variable-length thing in one
// is the stacking descriptor, which is 2.6kB of bytes rendered as a JSON array, so
// ~16kB at its widest. Sized generously rather than exactly because the cost of
// being wrong is a second call, and the cost of being generous is one allocation
// per photo that never leaves this function.
const REPLY_CAPACITY = 64 * 1024;

/**
 * Builds every rendition one job names, and returns what came back.
 *
 * Throws on failure, with the reason the library gave. A partial job is the
 * caller's to clean up: the worker deletes every output its job names, which is
 * what keeps a failed run from leaving half a photo on disk (§10.3).
 */
export function runJob(job: Job): JobOutcome {
  const command = Buffer.from(JSON.stringify(job), 'utf8');
  let reply = new Uint8Array(REPLY_CAPACITY);
  let written = Number(shim().bb_run_job(command, command.byteLength, ptr(reply), reply.byteLength));

  // Larger than the buffer means nothing was written and the size is what it needs.
  // Retried rather than sized up front because the common case fits and asking twice
  // costs one more call, not one more job: the work is done and only the reply is
  // being handed over again.
  if (written > reply.byteLength) {
    reply = new Uint8Array(written);
    written = Number(shim().bb_run_job(command, command.byteLength, ptr(reply), reply.byteLength));
  }
  if (written < 0) throw new Error('rawshim could not run the job');

  const parsed = JSON.parse(new TextDecoder().decode(reply.subarray(0, written))) as JobReply;
  if (!parsed.ok) throw new Error(parsed.error ?? 'rawshim could not run the job');
  const descriptor = parsed.outcome?.descriptor;
  return { descriptor: descriptor == null ? undefined : Uint8Array.from(descriptor) };
}

// A transcoded rendition is usually a couple of megabytes; 32MB covers a
// native-resolution one comfortably. Generous rather than exact because being
// wrong costs a second encode, and being generous costs one allocation on a path
// taken occasionally.
const TRANSCODE_CAPACITY = 32 * 1024 * 1024;

/**
 * A stored rendition as JPEG bytes, for a download.
 *
 * The one call that hands bytes back rather than writing a file - it is a response
 * body, which is the exception the no-pixels rule was always stated with. Still no
 * address crosses: the bytes are copied into a buffer this side owns.
 */
export function transcodeJpeg(filePath: string, longEdge: number, quality: number): Buffer {
  const path = Buffer.from(`${filePath}\0`);
  let out = new Uint8Array(TRANSCODE_CAPACITY);
  let written = Number(shim().bb_transcode_jpeg(path, longEdge, quality, ptr(out), out.byteLength));
  if (written > out.byteLength) {
    out = new Uint8Array(written);
    written = Number(shim().bb_transcode_jpeg(path, longEdge, quality, ptr(out), out.byteLength));
  }
  if (written < 0) throw new Error(`rawshim could not transcode ${filePath}`);
  return Buffer.from(out.subarray(0, written));
}

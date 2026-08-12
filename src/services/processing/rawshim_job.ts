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

/**
 * Where a rendition's highlights roll into, and what codes the result.
 *
 * The only thing a rendition's dynamic range reaches inside the pipeline: everything
 * upstream is one 16-bit scene-linear render, and this picks the peak the BT.2390 roll-off
 * targets and the transfer and depth of the buffer that leaves. A job is therefore one
 * render with a list of outputs, which is what lets several renditions of a photo share
 * the decode, the fit, the filter and the colour transform (§10.3).
 */
export type JobOutput = 'pq' | 'srgb';

export interface JobTarget {
  rendition: Rendition;
  output: JobOutput;
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
   * One tile of the photograph rather than the whole of it: `[left, top, width, height]` in the
   * decoded image's own pixels, and only for `renderTile`.
   *
   * What the loupe magnifies. The crop restricts the demosaic's own work and the mosaic denoise
   * takes a window with it, so a tile is an unpack and two small pieces of work.
   */
  tile?: [number, number, number, number];
  /**
   * The Detail panel's two sliders, 0 to 100, exactly as `EditDoc` stores them (§10.9).
   *
   * Positions rather than strengths, and carried unconverted for the same reason the
   * exposure below is: the denoise that reads them is on the far side, it is a different
   * denoise from the editor's, and a number converted here would be in one of their units.
   */
  denoiseLuminance: number;
  denoiseColour: number;
  /**
   * How much of a deconvolution to blend into the sharpen, 0 to 1. Belongs to the render
   * rather than to a rendition, so every target shares it, and unitless - how much noise
   * the frame has is measured off its own pixels on the far side, not passed in.
   */
  sharpen: number;
  defringe: number;
  /**
   * The photographer's exposure **in stops**, exactly as `EditDoc` stores it. 0 is as metered.
   *
   * The document's own unit, carried to the shader untouched: `colour.wgsl` raises it. It was
   * the `2^EV` gain, converted here and again in the editor, which is one rule with an
   * implementation on each path - and the kind that fails quietly, both answers being plausible
   * exposures.
   */
  exposure: number;
  /**
   * Every slider but the exposure, on Camera Raw's -100..100 scales, as `adjust.wgsl` reads
   * them. All zero is the picture as the camera rendered it.
   *
   * Separate from `exposure` because that one is a gain the tone anchor moves against, where
   * these are terms in the grade itself - including the presence three, whose neighbourhood
   * arrives as a blur built once per frame rather than as a second grade.
   */
  adjust: JobAdjust;
  /**
   * The reader's crop, straighten and quarter turn.
   *
   * `crop` is left, top, right, bottom as fractions of the *straightened* frame, which is
   * Camera Raw's definition and what `EditDocSchema` stores. Applied inside the cut's own
   * gather, so a crop costs a smaller output rather than a second copy of the frame.
   */
  geometry: JobGeometry;
  grade: JobGrade;
  targets: JobTarget[];
}

export interface JobGeometry {
  crop: [number, number, number, number];
  angleDegrees: number;
  rotate: number;
  /**
   * The perspective correction, corrected back to source in fractions of the frame, or null.
   *
   * Under the crop and the straighten in the gather, because it corrects the camera's angle to
   * the subject rather than anything the reader chose about the framing.
   */
  keystone: number[] | null;
}

export interface JobAdjust {
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
  /**
   * The illuminant the reader asked for, or null for the one the camera chose.
   *
   * Null rather than the as-shot numbers, because that is what the document stores and it has
   * to: an edit recording 5500K would mean a different picture on a frame the camera metered
   * at 3200, where "as shot" means the same thing on every one. What it is resolved against
   * comes off the decode, not off the job.
   */
  temperature: number | null;
  tint: number | null;
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
/**
 * One tile of a photograph, graded and encoded, as JPEG bytes.
 *
 * The same `Job` a rendition takes, with `tile` set. Bytes back rather than a descriptor,
 * because a tile is a response and not a file: writing one to disk to read it straight back is
 * the only reason it would have a path.
 *
 * Sized the way `transcodeJpeg` beside it is, and generously, because the retry costs the
 * *encode* again rather than the decode.
 */
export function renderTile(job: Job): Buffer {
  const command = Buffer.from(JSON.stringify(job), 'utf8');
  let out = new Uint8Array(TILE_CAPACITY);
  let written = Number(shim().bb_render_tile(command, command.byteLength, ptr(out), out.byteLength));
  if (written > out.byteLength) {
    out = new Uint8Array(written);
    written = Number(shim().bb_render_tile(command, command.byteLength, ptr(out), out.byteLength));
  }
  if (written < 0) throw new Error('rawshim could not render the tile');
  return Buffer.from(out.subarray(0, written));
}

// A 700px JPEG at quality 96 is a few hundred kilobytes; 8MB is far past any tile this serves
// and costs one allocation on a path that answers in about a tenth of a second.
const TILE_CAPACITY = 8 * 1024 * 1024;

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

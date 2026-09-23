// One photo's renditions, run by the native library (DESIGN §10.3).
//
// The whole boundary for this path: a command in, a result out, both JSON. Nothing
// here holds an address the library gave it, so there is no handle to free, no
// ordering to get right between calls, and no way for a mistake on this side to
// reach freed memory. The orchestration - the lazy decodes, the shared base, the
// release ordering - is in `job.rs` rather than in the worker, where the compiler can
// see the lifetimes it depends on.
import { ptr } from 'bun:ffi';
import { type Job, JobReplySchema, type RawHeaderFields } from '../../../schemas/jobs';
import { shim } from './rawshim';

export interface JobOutcome {
  /** The stacking descriptor a grid tile produced (§19.3), or undefined. */
  descriptor?: Uint8Array;
  /**
   * What this job measured that the caller did not already have, to keep against the photo.
   *
   * Undefined where the job was given everything, so this means "new, store it" rather than "here
   * it is again". About 5KB, and it saves the next render, rebuild, editor open and loupe tile
   * most of a second each.
   */
  photoAnalysis?: Uint8Array;
  /** The catalogue's fields, where the job asked for them. */
  header?: RawHeaderFields;
  /** The recipe an align found, as JSON for the caller to store on the stack. */
  composite?: string;
}


// Big enough for any reply the job produces. Two things in one are variable-length and both
// are bytes rendered as a JSON array, which costs up to four characters each: the stacking
// descriptor at 2.6kB (~16kB rendered) and the photo analysis at 5kB (~20kB). Sized generously
// rather than exactly because the cost of being wrong is a second call - which re-renders the
// *reply*, not the job - and the cost of being generous is one allocation per photo that never
// leaves this function.
const REPLY_CAPACITY = 128 * 1024;

/**
 * Builds every rendition one job names, and returns what came back.
 *
 * Throws on failure, with the reason the library gave. A partial job is the
 * caller's to clean up: the worker deletes every output its job names, which is
 * what keeps a failed run from leaving half a photo on disk (§10.3).
 */
export function runJob(job: Job): JobOutcome {
  const command = Buffer.from(JSON.stringify(job), 'utf8');
  return replied((reply) => Number(shim().bb_run_job(command, command.byteLength, ptr(reply), reply.byteLength)));
}

/**
 * Encodes and writes the one rendition `job` names from what a client rendered of it
 * (`job::render_bytes`'s frame), exactly as `runJob` would have written it.
 */
export function writeRendered(job: Job, framed: Uint8Array): JobOutcome {
  const command = Buffer.from(JSON.stringify(job), 'utf8');
  return replied((reply) =>
    Number(
      shim().bb_write_rendered(command, command.byteLength, ptr(framed), framed.byteLength, ptr(reply), reply.byteLength),
    ),
  );
}

function replied(call: (reply: Uint8Array) => number): JobOutcome {
  let reply = new Uint8Array(REPLY_CAPACITY);
  let written = call(reply);

  // Larger than the buffer means nothing was written and the size is what it needs.
  // Retried rather than sized up front because the common case fits and asking twice
  // costs one more call, not one more job: the work is done and only the reply is
  // being handed over again.
  if (written > reply.byteLength) {
    reply = new Uint8Array(written);
    written = call(reply);
  }
  if (written < 0) throw new Error('rawshim could not run the job');

  const parsed = JobReplySchema.parse(JSON.parse(new TextDecoder().decode(reply.subarray(0, written))));
  if (!parsed.ok) throw new Error(parsed.error ?? 'rawshim could not run the job');
  const descriptor = parsed.outcome?.descriptor;
  const photoAnalysis = parsed.outcome?.photoAnalysis;
  return {
    descriptor: descriptor == null ? undefined : Uint8Array.from(descriptor),
    // Present only where this job measured something new, so its presence means "keep this"
    // rather than "here it is again".
    photoAnalysis: photoAnalysis == null ? undefined : Uint8Array.from(photoAnalysis),
    header: parsed.outcome?.header,
    composite: parsed.outcome?.composite,
  };
}

/**
 * How far the job counting itself right now has got, or null where none is.
 *
 * Read from the main thread while a worker is inside its job: the call that does the work blocks
 * the thread that made it for as long as it takes, so the count comes out of the library rather
 * than out of the call.
 */
function jobProgress(): { done: number; total: number } | null {
  const packed = BigInt(shim().bb_job_progress());
  const total = Number(packed & 0xffffffffn);
  return total === 0 ? null : { done: Number(packed >> 32n), total };
}

/** `assembly_planes::CANCELLED`: the whole of what a job a cancel reached fails with. */
export const JOB_CANCELLED = 'cancelled';

/**
 * Tells whatever job is running right now to stop at its next boundary.
 *
 * Seen only by a job reporting progress, and cleared as one starts - so a cancel that
 * arrives between two jobs stops neither. The job it reaches fails with `JOB_CANCELLED`.
 */
export function cancelJob(): void {
  shim().bb_cancel_job();
}

/**
 * `run`, with what each render allocates kept for the next until it settles.
 *
 * For a queue of renders, where the denoise's arena is a tenth of each one. A render outside any
 * of these frees what it allocated as it finishes, so nothing is held while nothing renders.
 */
export async function holdingRenderMemory<T>(run: () => Promise<T>): Promise<T> {
  shim().bb_hold_render_memory();
  try {
    return await run();
  } finally {
    shim().bb_release_render_memory();
  }
}

const POLL_MS = 250;

/** One job, with `report` told how far into it the native side is until it ends. */
export async function watchingJobProgress<T>(
  before: number,
  share: number,
  report: (fraction: number) => void,
  run: () => Promise<T>,
): Promise<T> {
  report(before);
  const timer = setInterval(() => {
    const counted = jobProgress();
    if (counted != null) report(before + share * (counted.done / counted.total));
  }, POLL_MS);
  try {
    return await run();
  } finally {
    clearInterval(timer);
    report(before + share);
  }
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

/**
 * An SDR base and its HDR twin as one file with a gain map between them (§10.5).
 *
 * Both paths are renders of one export at one size. `quality` is the container's own scale -
 * libaom's quantizer for an AVIF, JPEG's 1-100 for a JPEG - and covers the map as well as the
 * base. Bytes back rather than a file, for the reason `transcodeJpeg` above hands them back: it
 * is a response body.
 */
export function writeGainMap(
  basePath: string,
  alternatePath: string,
  format: 'avif' | 'jpeg',
  quality: number,
  speed: number,
): Buffer {
  const base = Buffer.from(`${basePath}\0`);
  const alternate = Buffer.from(`${alternatePath}\0`);
  const container = Buffer.from(`${format}\0`);
  const call = (out: Uint8Array): number =>
    Number(shim().bb_write_gain_map(base, alternate, container, quality, speed, ptr(out), out.byteLength));
  let out = new Uint8Array(TRANSCODE_CAPACITY);
  let written = call(out);
  if (written > out.byteLength) {
    out = new Uint8Array(written);
    written = call(out);
  }
  if (written < 0) throw new Error(`rawshim could not write a gain map for ${basePath}`);
  return Buffer.from(out.subarray(0, written));
}

/**
 * A rendered AVIF re-encoded as one of the export formats that is not AVIF or JPEG (§10.5).
 *
 * `distance` is JXL's butteraugli distance, which PNG and TIFF ignore.
 */
export function exportStill(
  filePath: string,
  format: 'png' | 'png-hdr' | 'tiff' | 'jxl' | 'jxl-hdr',
  distance = 0,
): Buffer {
  const path = Buffer.from(`${filePath}\0`);
  const name = Buffer.from(`${format}\0`);
  const call = (out: Uint8Array): number =>
    Number(shim().bb_export_still(path, name, distance, ptr(out), out.byteLength));
  let out = new Uint8Array(TRANSCODE_CAPACITY);
  let written = call(out);
  if (written > out.byteLength) {
    out = new Uint8Array(written);
    written = call(out);
  }
  if (written < 0) throw new Error(`rawshim could not write ${filePath} as ${format}`);
  return Buffer.from(out.subarray(0, written));
}


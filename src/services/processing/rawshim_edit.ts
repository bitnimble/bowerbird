// The editor's open, run by the native library (`docs/raw-edit-gpu.md` §6, §10).
//
// The same command-in / bytes-out boundary the rendition job uses, and for the same
// reason, with one difference: this one really does hand pixels back. The tick that
// follows it is shader dispatches on the client, and there is no decoder in the page any
// more, so the prepared frame is the only thing that can cross.
//
// The reply is framed rather than JSON: a little-endian u32 header length, that many bytes
// of JSON, then the samples as little-endian u16 RGB. Base64 of 59MB would be neither
// cheap nor honest, and splitting the header into a second request would let the two
// disagree about which frame they describe.
import { FFIType, JSCallback, ptr } from 'bun:ffi';
import { shim } from './rawshim';
import type { JobGrade } from './rawshim_job';

export interface EditStrengths {
  luma: number;
  chroma: number;
  sharpen: number;
  defringe: number;
}

export interface EditRequest {
  rawFilePath: string;
  /** Longest edge the decode is fitted to, which is the size every tick then grades. */
  longEdge: number;
  grade: JobGrade;
  strengths: EditStrengths;
}

/** `ChromaMap`'s lattice, flat, with the axis constants a shader walks it by. */
export interface ChromaPayload {
  nodes: number[];
  chromaCount: number;
  levelCount: number;
  chromaLow: number;
  chromaScale: number;
  levelScale: number;
}

/** The camera match, flattened into what a shader can index. */
export interface ColourPayload {
  curves: [number[], number[], number[]];
  matrix: [[number, number, number], [number, number, number], [number, number, number]];
  saturation: number;
  trustCeiling: number;
  chroma: ChromaPayload | null;
}

export interface PreparedHeader {
  ok: boolean;
  error?: string;
  width: number;
  height: number;
  /** `tone::Levels`: the frame's own diffuse white and peak, in input levels. */
  white: number;
  peak: number;
  grade: JobGrade;
  strengths: EditStrengths;
  matched: boolean;
  colour: ColourPayload | null;
  samplesLen: number;
}

/** Which promise a finished job belongs to: "job 7 is done" becomes the call that asked. */
const pending = new Map<number, (reply: { length: number }) => void>();

const finished = new JSCallback(
  (job: number | bigint, length: number | bigint) => {
    const settle = pending.get(Number(job));
    pending.delete(Number(job));
    settle?.({ length: Number(length) });
  },
  { args: [FFIType.u64, FFIType.i64], returns: FFIType.void, threadsafe: true },
);

let notified = false;

/**
 * Identical opens in flight share one, keyed by the whole request.
 *
 * Nothing else bounds how many of these run at once. The open used to block this thread,
 * which serialised it by accident; now it is a thread per call, and a reader who opens the
 * editor, presses Escape and opens it again has left the first one running - the client
 * cannot cancel work the native side has already started, and would not stop it by
 * abandoning the request. Ten of those in five seconds is ten simultaneous LibRaw decodes
 * of the same 61MP RAW, which is several gigabytes and the end of the process.
 *
 * The prepare is a pure function of its request, so the second caller wants exactly what
 * the first is already waiting for. Same shape as `processing_service`'s batch dedup, for
 * the same reason.
 */
const inFlight = new Map<string, Promise<Uint8Array>>();

/**
 * Decodes, prepares, fits the camera match and materialises the lens warp - without
 * stopping the server for the length of it.
 *
 * The open is seconds of LibRaw on the one thread that answers every other request, so
 * doing it in line froze the library until it finished. This starts the work on a thread
 * the native side owns and returns a promise: the completion arrives as a callback, which
 * is `postMessage` rather than a thread pool, and needs no worker on this side at all.
 *
 * The callback is registered once and shared. Bun's `threadsafe` flag is what makes it
 * legal to enter from a thread that is not this one.
 */
export function prepareEditAsync(request: EditRequest): Promise<Uint8Array> {
  const key = JSON.stringify(request);
  const running = inFlight.get(key);
  if (running != null) return running;

  const run = startEdit(request).finally(() => inFlight.delete(key));
  // Before any `.finally` callback can run, since those are microtasks and this is not -
  // so the key is never deleted before it is set.
  inFlight.set(key, run);
  return run;
}

async function startEdit(request: EditRequest): Promise<Uint8Array> {
  if (!notified) {
    shim().bb_prepare_edit_notify(finished.ptr);
    notified = true;
  }

  const command = Buffer.from(JSON.stringify(request), 'utf8');
  const job = Number(shim().bb_prepare_edit_start(command, command.byteLength));
  if (job === 0) throw new Error('rawshim would not start the open');

  const { length } = await new Promise<{ length: number }>((resolve) => pending.set(job, resolve));
  if (length < 0) throw new Error('rawshim could not open the RAW for editing');

  // Taken or dropped, never left: the reply is held on the far side under this job's id
  // until one of the two happens, and it is a whole frame. Allocating the buffer is the step
  // that can fail - at 61MP it is 361MB - and failing it must not strand the 361MB waiting
  // to be copied into it.
  let taken = false;
  try {
    const reply = new Uint8Array(length);
    const written = Number(shim().bb_prepare_edit_take(BigInt(job), ptr(reply), reply.byteLength));
    taken = true;
    if (written < 0) throw new Error('the prepared frame was gone before it could be read');
    const framed = reply.subarray(0, written);
    // The header is read, and nothing else is. `encode` already writes the frame in the shape
    // the page reads, padding and all, so this hands the buffer on rather than taking it
    // apart and putting it back together: at 61MP that round trip was two 361MB copies with
    // three of them alive at once, for a reply that arrived correct.
    throwIfFailed(framed);
    return framed;
  } finally {
    if (!taken) shim().bb_prepare_edit_take(BigInt(job), null, 0);
  }
}


/**
 * The header, read out of a framed reply without touching the samples after it.
 *
 * A failed open is a reply like any other - `ok: false` and a reason - so somebody has to
 * look, and this is the only part of the frame the server has any use for. The samples are
 * the client's, and the whole point of the framing is that they cross without being handled.
 */
export function headerOf(framed: Uint8Array): PreparedHeader {
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const length = view.getUint32(0, true);
  return JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))) as PreparedHeader;
}

function throwIfFailed(framed: Uint8Array): void {
  const header = headerOf(framed);
  if (!header.ok) throw new Error(header.error ?? 'rawshim could not open the RAW for editing');
}

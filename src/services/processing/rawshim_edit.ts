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
import { ptr } from 'bun:ffi';
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
  /** `image::measurements`, taken once at open and reused by every tick. */
  sigma: number;
  defocusRed: number;
  defocusBlue: number;
  samplesLen: number;
}

export interface PreparedFrame {
  header: PreparedHeader;
  /** Scene-linear `u16` RGB, warped, at `width * height * 3`. */
  samples: Uint16Array;
}

// Only ever the header on the first call: sized for the JSON alone so the sizing call does
// not allocate a frame's worth of buffer to be told how big the frame is. The camera match
// carries three 256-sample curves and a 100-node lattice, so a few tens of kB.
const HEADER_CAPACITY = 256 * 1024;

/**
 * Decodes, prepares, fits the camera match and materialises the lens warp.
 *
 * Two calls by design rather than by accident: the first is handed a header-sized buffer
 * and comes back with the length the frame needs, the second reads it into a buffer that
 * fits. The work is not repeated - `bb_prepare_edit` runs the open on the first call and
 * the second is the copy-out - which is the same protocol `runJob` uses for its replies.
 */
export function prepareEdit(request: EditRequest): PreparedFrame {
  const command = Buffer.from(JSON.stringify(request), 'utf8');
  let reply = new Uint8Array(HEADER_CAPACITY);
  let written = Number(
    shim().bb_prepare_edit(command, command.byteLength, ptr(reply), reply.byteLength),
  );
  if (written < 0) throw new Error('rawshim could not open the RAW for editing');
  if (written > reply.byteLength) {
    reply = new Uint8Array(written);
    written = Number(
      shim().bb_prepare_edit(command, command.byteLength, ptr(reply), reply.byteLength),
    );
    if (written < 0) throw new Error('rawshim could not open the RAW for editing');
  }
  return decode(reply.subarray(0, written));
}

/**
 * The frame as one buffer: a `u32` length, that much JSON, then the samples.
 *
 * The header travels in the body rather than in an `X-Prepared` response header because
 * once the camera match is in it, it is 11KB - three 256-sample curves and a 400-value
 * lattice - and nginx answers 502 rather than forward an upstream header past its 4KB
 * buffer. Measured, not assumed: an unmatched frame's header is 247 bytes, which is why
 * this only ever failed against real photographs.
 *
 * Padded to a multiple of four, which JSON ignores and the reader depends on: it leaves
 * the samples where a `Uint16Array` can view them rather than copy them, which is what
 * putting the header outside the body bought in the first place.
 */
export function framePrepared(frame: PreparedFrame): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(frame.header));
  const padded = Math.ceil(json.byteLength / 4) * 4;
  const samples = new Uint8Array(
    frame.samples.buffer,
    frame.samples.byteOffset,
    frame.samples.byteLength,
  );

  const out = new Uint8Array(4 + padded + samples.byteLength);
  new DataView(out.buffer).setUint32(0, padded, true);
  out.set(json, 4);
  out.fill(0x20, 4 + json.byteLength, 4 + padded);
  out.set(samples, 4 + padded);
  return out;
}

/** Splits the framing, so the route and the tests read one implementation of it. */
export function decode(reply: Uint8Array): PreparedFrame {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(reply.subarray(4, 4 + headerLength)),
  ) as PreparedHeader;
  if (!header.ok) throw new Error(header.error ?? 'rawshim could not open the RAW for editing');

  const at = 4 + headerLength;
  // Copied rather than viewed: the samples begin at a header-dependent offset, which is
  // almost never the 2-byte alignment a `Uint16Array` view over the same buffer needs.
  const samples = new Uint16Array(header.samplesLen / 2);
  new Uint8Array(samples.buffer).set(reply.subarray(at, at + header.samplesLen));
  return { header, samples };
}

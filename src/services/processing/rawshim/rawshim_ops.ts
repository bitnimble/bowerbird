// What the library will answer about a file without decoding it, and the two calls
// that are neither a job nor a question about pixels.
//
// Nothing here holds anything. Every call is arguments in and values out - a struct
// this side allocated and the library fills, or a count, or bytes written into a
// buffer this side owns. No address the library allocated is ever handed over, so
// there is nothing to keep alive between calls and nothing to free.
//
// Not a handle API: no decode returns a pointer for each operation to take, with freeing
// held up by `finally` blocks and comments. Renditions go through `rawshim_job.ts` and
// the tests through `rawshim_for_testing.ts`, both of which are command in, values out.
// What is here is the scalar part.

import { statSync } from 'node:fs';
import { ptr } from 'bun:ffi';
import type { CaptureSequence, CaptureSequenceKind } from '../../../schemas/capture_sequence';
import type { RawHeaderFields } from '../../../schemas/jobs';
import { shim } from './rawshim';

// #[repr(C)] BbHeader: u32 width/height, i32 orientation, f32 iso/shutter/aperture
// /focal, 4 bytes padding, i64 timestamp, f64 latitude/longitude, then NUL-padded
// char arrays: u8 make[64], model[64], lens[128], then u32 sequence kind/group/index/count.
const HEADER = {
  width: 0,
  height: 4,
  orientation: 8,
  iso: 12,
  shutter: 16,
  aperture: 20,
  focal: 24,
  timestamp: 32,
  latitude: 40,
  longitude: 48,
  make: 56,
  model: 120,
  lens: 184,
  sequenceKind: 312,
  sequenceGroup: 316,
  sequenceIndex: 320,
  sequenceCount: 324,
  size: 328,
} as const;

/** `header::SEQUENCE_*`. */
const SEQUENCE_KINDS: Record<number, CaptureSequenceKind> = { 1: 'pixelShift', 2: 'exposureBracket' };

function sequenceOf(view: DataView): CaptureSequence | null {
  const kind = SEQUENCE_KINDS[view.getUint32(HEADER.sequenceKind, true)];
  if (kind == null) return null;
  const known = (value: number): number | null => (value === 0 ? null : value);
  return {
    kind,
    group: known(view.getUint32(HEADER.sequenceGroup, true)),
    index: view.getUint32(HEADER.sequenceIndex, true),
    count: known(view.getUint32(HEADER.sequenceCount, true)),
  };
}

function name(raw: Uint8Array, at: number, size: number): string | null {
  const bytes = raw.subarray(at, at + size);
  const end = bytes.indexOf(0);
  const text = new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end)).trim();
  // A blank or all-dashes name is "unknown", not a name worth storing.
  return text === '' || /^-+$/.test(text) ? null : text;
}

/**
 * Dimensions, orientation, capture time, GPS and the exposure a RAW records, with
 * no pixel decoded.
 *
 * One flat struct of our own, read at fixed offsets and size-checked at the first call,
 * rather than five C structs reached at hardcoded offsets with one of them found by
 * assuming where another sits inside a sixth (§10.4).
 */
export function readHeaderFields(filePath: string): RawHeaderFields {
  const S = shim();
  const size = Number(S.bb_header_size());
  if (size !== HEADER.size) {
    throw new Error(`BbHeader is ${size} bytes but this reader assumes ${HEADER.size}; the offsets here need updating`);
  }

  const raw = new Uint8Array(size);
  if (S.bb_read_header(Buffer.from(`${filePath}\0`), ptr(raw)) !== 0) {
    throw new Error(`rawshim could not read the header of ${filePath}`);
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const positive = (value: number): number | null => (value > 0 ? value : null);
  const finite = (value: number): number | null => (Number.isNaN(value) ? null : value);
  const seconds = Number(view.getBigInt64(HEADER.timestamp, true));

  return {
    width: view.getUint32(HEADER.width, true),
    height: view.getUint32(HEADER.height, true),
    orientation: view.getInt32(HEADER.orientation, true),
    timestamp: seconds === 0 ? null : seconds,
    latitude: finite(view.getFloat64(HEADER.latitude, true)),
    longitude: finite(view.getFloat64(HEADER.longitude, true)),
    iso: positive(view.getFloat32(HEADER.iso, true)),
    shutterSpeed: positive(view.getFloat32(HEADER.shutter, true)),
    aperture: positive(view.getFloat32(HEADER.aperture, true)),
    focalLength: positive(view.getFloat32(HEADER.focal, true)),
    cameraMake: name(raw, HEADER.make, 64),
    cameraModel: name(raw, HEADER.model, 64),
    lensModel: name(raw, HEADER.lens, 128),
    sequence: sequenceOf(view),
  };
}

/** Bytes one photo's stacking descriptor occupies, as the library reports it. */
export function descriptorSize(): number {
  return Number(shim().bb_descriptor_size());
}

/**
 * The byte every descriptor of this format begins with.
 *
 * Comparison refuses one that does not carry it by scoring the pair as unalike, so a descriptor
 * assembled without it produces no stacks and no complaint.
 */
export function descriptorFormat(): number {
  return shim().bb_descriptor_format();
}

/**
 * Groups frames into stacks, given their descriptors in ascending time order.
 *
 * Returns a group index per frame, or -1 for one that ended up alone. The whole
 * walk runs in Rust: a comparison is descriptor arithmetic over a couple of
 * thousand cells, and a library-sized pass makes hundreds of thousands of them.
 */
export function stackGroups(
  descriptors: Buffer[],
  timestamps: BigInt64Array,
  threshold: number,
  windowSeconds: number,
): Int32Array {
  const out = new Int32Array(descriptors.length);
  if (descriptors.length === 0) return out;
  // Checked rather than trusted, because the other side reads
  // `count * descriptorSize()` bytes from this pointer in one go: a single blob
  // of the wrong length - a row written by another version of the descriptor, a
  // truncated column - would have it read past the end of the buffer rather
  // than merely produce a bad score.
  const size = descriptorSize();
  const wrong = descriptors.findIndex((descriptor) => descriptor.length !== size);
  if (wrong !== -1) {
    throw new Error(`descriptor ${wrong} is ${descriptors[wrong]!.length} bytes, expected ${size}`);
  }
  if (timestamps.length !== descriptors.length) {
    throw new Error(`${timestamps.length} timestamps for ${descriptors.length} descriptors`);
  }
  const joined = Buffer.concat(descriptors);
  const status = shim().bb_stack_groups(
    ptr(joined),
    ptr(timestamps),
    descriptors.length,
    threshold,
    BigInt(windowSeconds),
    ptr(out),
  );
  if (status !== 0) throw new Error('rawshim could not group those descriptors');
  return out;
}

/**
 * Blanks every tag that names a person or a place, in `bytes` itself.
 *
 * False for a container the library cannot read, which leaves the bytes exactly as they were:
 * the caller has to answer that by not sending the file rather than by sending it anyway.
 */
export function scrubExif(bytes: Buffer): boolean {
  return shim().bb_scrub_exif(ptr(bytes), bytes.byteLength) === 1;
}

/**
 * The camera's embedded JPEG preview, as bytes. Null when the file has none.
 *
 * The one call besides a finished rendition that hands bytes over, because its
 * caller serves them to an HTTP response. Into a buffer this side
 * allocated, sized off the RAW: the preview is a byte range inside it, so the file
 * is its bound, and asking the library how large it is means extracting it twice.
 */
export function extractEmbedded(filePath: string, rotate = 0): Buffer | null {
  const path = Buffer.from(`${filePath}\0`);
  // A file that is not there reads as a file with no preview, which is what the
  // library itself answered when it was the one to open it.
  const stats = statSync(filePath, { throwIfNoEntry: false });
  if (stats == null) return null;
  // Uninitialised, because the pages this never writes are never touched: a 90MB
  // bound zeroed on every request would cost more than the extraction.
  const out = Buffer.allocUnsafe(stats.size);
  const extract = (buffer: Buffer): number => Number(shim().bb_extract_embedded(path, rotate, ptr(buffer), buffer.byteLength));
  const written = extract(out);
  if (written === -2) throw new Error('rawshim could not tag the preview orientation');
  if (written < 0) throw new Error(`rawshim could not read the preview of ${filePath}`);
  if (written === 0) return null;
  if (written > out.byteLength) {
    const exact = Buffer.alloc(written);
    if (extract(exact) !== written) {
      throw new Error(`rawshim could not read the preview of ${filePath}`);
    }
    return exact;
  }
  // Copied out rather than returned as a view: a view keeps the whole RAW-sized
  // allocation behind it alive for as long as the caller holds the preview.
  return Buffer.from(out.subarray(0, written));
}

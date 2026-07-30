// What the library will answer about a file without decoding it, and the two calls
// that are neither a job nor a question about pixels.
//
// Nothing here holds anything. Every call is arguments in and values out - a struct
// this side allocated and the library fills, or a count, or bytes written into a
// buffer this side owns. No address the library allocated is ever handed over, so
// there is nothing to keep alive between calls and nothing to free.
//
// This module used to be the handle API: a decode returned a pointer, each operation
// took one, and freeing them was a convention held up by `finally` blocks and
// comments. Renditions go through `rawshim_job.ts` now and the tests through
// `rawshim_debug.ts`, both of which are command in, values out. What is left is the
// part that was always scalar.

import { ptr } from 'bun:ffi';
import { shim } from './rawshim';

// #[repr(C)] BbHeader: u32 width/height, i32 orientation, f32 iso/shutter/aperture
// /focal, 4 bytes padding, i64 timestamp, f64 latitude/longitude, then NUL-padded
// char arrays: u8 make[64], model[64], lens[128].
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
  size: 312,
} as const;

export interface RawHeaderFields {
  width: number;
  height: number;
  orientation: number;
  /** Epoch seconds as LibRaw's `mktime` produced them, or null. */
  timestamp: number | null;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutterSpeed: number | null;
  aperture: number | null;
  focalLength: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
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
 * Every field is resolved from LibRaw's own typed structs in Rust; this reads one
 * flat struct of our own at fixed offsets, size-checked at the first call. It used
 * to reach into five of LibRaw's structs from here at hardcoded offsets, one of
 * them by assuming where `sizes` sits inside `libraw_data_t` (§10.4).
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
  };
}

// #[repr(C)] BbHdrOptions: u32 medium, u32 stillChroma, f64 peak/referenceWhite
// /whiteQuantile, i32 crf, i32 preset, f64 maxEdge. `stillChroma` sits in the padding
// `medium` already had before the first f64, so the struct is the size it always was
// and the check below still passes on an unchanged number.
const HDR_OPTIONS = {
  medium: 0,
  stillChroma: 4,
  peakNits: 8,
  referenceWhiteNits: 16,
  whiteQuantile: 24,
  crf: 32,
  preset: 36,
  maxEdge: 40,
  size: 48,
} as const;

// One transfer, two media. The SDR reference and the 4:2:0 baseline control went
// with the check page they were built to be compared on.
const MEDIA = ['still', 'video'] as const;

export interface HdrOptions {
  medium: (typeof MEDIA)[number];
  outputPath: string;
  peakNits: number;
  referenceWhiteNits: number;
  whiteQuantile: number;
  crf: number;
  preset: number;
  /**
   * 4:4:4 rather than 4:2:0 for a still. Ignored for the video, which has no choice:
   * 4:4:4 video is AV1 Profile 1, which Chromium refuses outright (§10.7).
   */
  stillFullChroma: boolean;
  /** Infinity for "whatever the frame is", which a native-resolution export asks. */
  maxEdge: number;
}

function hdrOptionsBuffer(options: HdrOptions): Uint8Array {
  const size = Number(shim().bb_hdr_options_size());
  if (size !== HDR_OPTIONS.size) {
    throw new Error(
      `BbHdrOptions is ${size} bytes but this writer assumes ${HDR_OPTIONS.size}; the offsets here need updating`,
    );
  }
  const raw = new Uint8Array(size);
  const view = new DataView(raw.buffer);
  view.setUint32(HDR_OPTIONS.medium, MEDIA.indexOf(options.medium), true);
  view.setUint32(HDR_OPTIONS.stillChroma, options.stillFullChroma ? 1 : 0, true);
  view.setFloat64(HDR_OPTIONS.peakNits, options.peakNits, true);
  view.setFloat64(HDR_OPTIONS.referenceWhiteNits, options.referenceWhiteNits, true);
  view.setFloat64(HDR_OPTIONS.whiteQuantile, options.whiteQuantile, true);
  view.setInt32(HDR_OPTIONS.crf, options.crf, true);
  view.setInt32(HDR_OPTIONS.preset, options.preset, true);
  view.setFloat64(HDR_OPTIONS.maxEdge, options.maxEdge, true);
  return raw;
}

/** Comfortably past any of these: the longest is ffmpeg's, at a few hundred bytes. */
const ARGV_CAPACITY = 8 * 1024;

/**
 * The argv the HDR encode would hand to ffmpeg or avifenc, and the size it targets.
 *
 * For the pin that holds this against the TypeScript it replaced
 * (`hdr_pin.integration.test.ts`). The app never needs it: a job builds and runs
 * these inside one call.
 */
export function hdrArgv(
  options: HdrOptions,
  width: number,
  height: number,
  which: 'ffmpeg' | 'avifenc' | 'size',
  y4mPath = '',
): string[] {
  const raw = hdrOptionsBuffer(options);
  const out = new Uint8Array(ARGV_CAPACITY);
  const written = Number(
    shim().bb_hdr_argv(
      ptr(raw),
      width,
      height,
      Buffer.from(`${options.outputPath}\0`),
      Buffer.from(`${y4mPath}\0`),
      ['ffmpeg', 'avifenc', 'size'].indexOf(which),
      ptr(out),
      out.byteLength,
    ),
  );
  if (written < 0 || written > out.byteLength) throw new Error('rawshim could not build the HDR arguments');
  return new TextDecoder().decode(out.subarray(0, written)).split('\0');
}

/** Bytes one photo's stacking descriptor occupies, as the library reports it. */
export function descriptorSize(): number {
  return Number(shim().bb_descriptor_size());
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
 * The camera's embedded JPEG preview, as bytes. Null when the file has none.
 *
 * The one call besides a finished rendition that hands bytes over, because its
 * caller serves them to an HTTP response unchanged. Into a buffer this side
 * allocated, sized by asking first - a preview runs 5-14MB on a modern body, which
 * is too much to guess at and too rarely wrong to pay for twice.
 */
export function extractEmbedded(filePath: string): Buffer | null {
  const path = Buffer.from(`${filePath}\0`);
  const size = Number(shim().bb_extract_embedded(path, null, 0));
  if (size < 0) throw new Error(`rawshim could not read the preview of ${filePath}`);
  if (size === 0) return null;

  const out = Buffer.alloc(size);
  const written = Number(shim().bb_extract_embedded(path, ptr(out), out.byteLength));
  if (written !== size) throw new Error(`rawshim could not read the preview of ${filePath}`);
  return out;
}

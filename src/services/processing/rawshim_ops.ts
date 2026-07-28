// Every image operation, all of which happen in Rust.
//
// The unit that crosses the boundary is a handle, not a picture. A decode returns
// one, each operation takes one, and the pixels stay in the library the whole
// time; a 60MP render is never copied into a JS `Buffer` for a caller that only
// wanted it resized and written to disk. Only two things read the samples back:
// the scene-linear decode the HDR encoder pipes to ffmpeg, and the fit that
// grades it, both through `pixels()` - which copies, and says so.
//
// Handles are freed explicitly, in a `finally`. Nothing on the JS side collects
// them, and a 60MP frame is 190MB of leak if one is dropped.

import { ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { shim } from './rawshim';
import type { OutputSpace } from './raw_decoder';

// #[repr(C)] BbImage: u32 width, u32 height, u32 depth, 4 bytes padding, *mut u8
// data, usize len, u32 halved, 4 bytes padding, usize capacity.
const IMAGE = { width: 0, height: 4, depth: 8, data: 16, len: 24, halved: 32, size: 48 } as const;

// BbBuffer is a data pointer, a length and a capacity, 8 bytes each.
const BUFFER = { data: 0, len: 8, size: 24 } as const;

// Neither layout can be derived from an accessor - a reader needs field offsets,
// and a size alone cannot give it those. Comparing the sizes instead turns what
// would be a silent misread of every image into one clear failure at the first
// call, because adding or removing a field changes them.
let layoutChecked = false;
function checkLayout(): void {
  if (layoutChecked) return;
  const S = shim();
  for (const [name, expected, actual] of [
    ['BbImage', IMAGE.size, Number(S.bb_image_header_size())],
    ['BbBuffer', BUFFER.size, Number(S.bb_buffer_header_size())],
  ] as const) {
    if (actual !== expected) {
      throw new Error(
        `${name} is ${actual} bytes but this reader assumes ${expected}; ` +
          'the struct gained or lost a field, so the offsets here need updating',
      );
    }
  }
  layoutChecked = true;
}

/**
 * A decoded image owned by the Rust library.
 *
 * The dimensions are read once, at creation, so a caller can size its work
 * without a call per property. Must be released with `freeImage`.
 */
export interface ImageHandle {
  readonly pointer: Pointer;
  readonly width: number;
  readonly height: number;
  readonly depth: 8 | 16;
  /** Whether the RAW decode ran at half size. False for anything else. */
  readonly halved: boolean;
}

function handleOf(pointer: Pointer | null, what: string): ImageHandle {
  if (!pointer) throw new Error(`rawshim could not ${what}`);
  checkLayout();
  const head = new DataView(toArrayBuffer(pointer, 0, IMAGE.size));
  return {
    pointer,
    width: head.getUint32(IMAGE.width, true),
    height: head.getUint32(IMAGE.height, true),
    depth: head.getUint32(IMAGE.depth, true) === 16 ? 16 : 8,
    halved: head.getUint32(IMAGE.halved, true) !== 0,
  };
}

export function freeImage(image: ImageHandle): void {
  shim().bb_free(image.pointer);
}

/**
 * Decodes a RAW to an upright RGB bitmap.
 *
 * `atLeastLongEdge` is the longest edge the caller needs; where halving the frame
 * still clears it, the decode runs at half size, which is far cheaper. 0 means
 * the whole frame, which is what a native-resolution rendition requires.
 */
export function decodeRawImage(
  filePath: string,
  depth: 8 | 16,
  space: OutputSpace,
  atLeastLongEdge: number,
): ImageHandle {
  const pointer = shim().bb_decode(
    Buffer.from(`${filePath}\0`),
    depth,
    space === 'rec2020-linear' ? 1 : 0,
    Math.max(0, Math.floor(atLeastLongEdge)),
  );
  return handleOf(pointer, `decode ${filePath}`);
}

/**
 * Decodes the camera's embedded preview from a RAW, fitted to `longEdge`. 0 leaves
 * it at whatever size the body embedded.
 *
 * The whole of an import's thumbnail stage in one call. Null when the file has no
 * JPEG preview, which is a property of the file rather than an error: the caller
 * falls back to a render.
 */
export function decodeEmbedded(filePath: string, longEdge = 0): ImageHandle | null {
  const pointer = shim().bb_decode_embedded(Buffer.from(`${filePath}\0`), longEdge);
  return pointer ? handleOf(pointer, `decode the preview in ${filePath}`) : null;
}

/**
 * Decodes an encoded image (a JPEG, an AVIF) off disk, applying its EXIF orientation
 * and fitting it to `longEdge`. 0 leaves the size alone.
 *
 * What a transcode of an existing rendition wants: reading the file into a `Buffer`
 * here only to hand it back is the round trip the handle API exists to remove.
 */
export function decodeFile(filePath: string, longEdge = 0): ImageHandle {
  return handleOf(shim().bb_decode_file(Buffer.from(`${filePath}\0`), longEdge), `decode ${filePath}`);
}

/**
 * Decodes an encoded image already in hand, applying its EXIF orientation and fitting
 * it to `longEdge`. 0 leaves the size alone.
 *
 * Only for bytes that exist on this side for another reason - a test constructing a
 * target. A file wants `decodeFile`, and a RAW's preview wants `decodeEmbedded`.
 */
export function decodeImage(bytes: Buffer, longEdge = 0): ImageHandle {
  return handleOf(shim().bb_decode_image(bytes, BigInt(bytes.length), longEdge), 'decode that image');
}

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

/**
 * The distortion spline the body recorded for this shot, in `SPLINE_UNIT`s, or
 * null when it recorded none.
 *
 * `fitProfile` reads this itself; this is here so a test can check the parser
 * against a real ARW, which the synthetic TIFFs in `lens.rs` cannot do.
 */
export function readDistortionSpline(rawFilePath: string): number[] | null {
  const knots = new Float64Array(64);
  const count = shim().bb_read_distortion_spline(Buffer.from(`${rawFilePath}\0`), ptr(knots), knots.length);
  if (count < 0) throw new Error(`rawshim could not read ${rawFilePath}`);
  return count === 0 ? null : Array.from(knots.subarray(0, count));
}

/**
 * A handle over a copy of RGB pixels JS already holds.
 *
 * The one direction that copies on purpose, and the app never needs it:
 * everything here decodes on the Rust side. It exists for tests, which construct
 * a target and need it in the form a decode would have produced.
 */
export function imageFromRgb(data: Buffer, width: number, height: number): ImageHandle {
  return handleOf(shim().bb_image_from_rgb(data, width, height), 'take those pixels');
}

/**
 * Fits to a longest edge and applies a profile, in that order. Either half is
 * optional: a null profile is a plain resize, and a `longEdge` of 0 grades at the
 * size the image arrived at.
 */
export function renderImage(image: ImageHandle, profile: FittedProfile | null, longEdge: number): ImageHandle {
  const pointer = shim().bb_render(image.pointer, profile == null ? null : ptr(profile.raw), longEdge);
  return handleOf(pointer, 'render that image');
}

/** AVIF, 4:4:4, fitted to `longEdge` and written straight to disk. */
export function saveAvif(image: ImageHandle, longEdge: number, quality: number, effort: number, outPath: string): void {
  const status = shim().bb_save_avif(image.pointer, longEdge, quality, effort, Buffer.from(`${outPath}\0`));
  if (status !== 0) throw new Error(`rawshim could not write ${outPath}`);
}

export function encodeJpeg(image: ImageHandle, longEdge: number, quality: number): Buffer {
  const bytes = takeBuffer(shim().bb_encode_jpeg(image.pointer, longEdge, quality));
  if (bytes == null) throw new Error('rawshim could not encode a JPEG');
  return bytes;
}

// #[repr(C)] BbHdrOptions: u32 variant, u32 medium, f64 peak/referenceWhite
// /whiteQuantile, i32 crf, i32 preset, f64 maxEdge.
const HDR_OPTIONS = {
  variant: 0,
  medium: 4,
  peakNits: 8,
  referenceWhiteNits: 16,
  whiteQuantile: 24,
  crf: 32,
  preset: 36,
  maxEdge: 40,
  size: 48,
} as const;

const VARIANTS = ['pq', 'sdr'] as const;
const MEDIA = ['still', 'still-baseline', 'video'] as const;

export interface HdrOptions {
  variant: (typeof VARIANTS)[number];
  medium: (typeof MEDIA)[number];
  outputPath: string;
  peakNits: number;
  referenceWhiteNits: number;
  whiteQuantile: number;
  crf: number;
  preset: number;
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
  view.setUint32(HDR_OPTIONS.variant, VARIANTS.indexOf(options.variant), true);
  view.setUint32(HDR_OPTIONS.medium, MEDIA.indexOf(options.medium), true);
  view.setFloat64(HDR_OPTIONS.peakNits, options.peakNits, true);
  view.setFloat64(HDR_OPTIONS.referenceWhiteNits, options.referenceWhiteNits, true);
  view.setFloat64(HDR_OPTIONS.whiteQuantile, options.whiteQuantile, true);
  view.setInt32(HDR_OPTIONS.crf, options.crf, true);
  view.setInt32(HDR_OPTIONS.preset, options.preset, true);
  view.setFloat64(HDR_OPTIONS.maxEdge, options.maxEdge, true);
  return raw;
}

/**
 * The argv the HDR encode would hand to ffmpeg or avifenc, and the size it targets.
 *
 * For the pin that holds this against the TypeScript it replaced
 * (`hdr_pin.integration.test.ts`). The app never needs it: `encodeHdr` builds and
 * runs these inside one call.
 */
export function hdrArgv(
  options: HdrOptions,
  width: number,
  height: number,
  which: 'ffmpeg' | 'avifenc' | 'size',
  y4mPath = '',
): string[] {
  const raw = hdrOptionsBuffer(options);
  const bytes = takeBuffer(
    shim().bb_hdr_argv(
      ptr(raw),
      width,
      height,
      Buffer.from(`${options.outputPath}\0`),
      Buffer.from(`${y4mPath}\0`),
      ['ffmpeg', 'avifenc', 'size'].indexOf(which),
    ),
  );
  if (bytes == null) throw new Error('rawshim could not build the HDR arguments');
  return bytes.toString('binary').split('\0');
}

/**
 * Builds one HDR rendition, from the RAW to the file on disk.
 *
 * The whole job in one call: the scene-linear decode, the camera's colour fitted in
 * the grade's own domain, the fit to size, the warp, the grade, and ffmpeg - with
 * avifenc after it for a still. None of the samples cross the boundary, which is the
 * reason for the shape: the graded frame is ~115MB at 24MP and ~366MB at 61MP.
 *
 * `profile` is the SDR fit, supplying the geometry the HDR colour is fitted through.
 * Null grades neutrally, which is what the HDR check page asks for.
 */
export function encodeHdrRendition(
  linear: ImageHandle,
  rawFilePath: string,
  options: HdrOptions,
  profile: FittedProfile | null,
): void {
  if (linear.depth !== 16) throw new Error(`the HDR encode needs a 16-bit decode, got ${linear.depth}`);
  const raw = hdrOptionsBuffer(options);
  const status = shim().bb_encode_hdr(
    linear.pointer,
    Buffer.from(`${rawFilePath}\0`),
    Buffer.from(`${options.outputPath}\0`),
    ptr(raw),
    profile == null ? null : ptr(profile.raw),
  );
  if (status !== 0) throw new Error(`rawshim could not encode ${options.outputPath}`);
}

// #[repr(C)] BbHdrColour: f64 deltaE, f64 saturation, f64 matrix[9], f64 curves[768].
const HDR_COLOUR = { deltaE: 0, saturation: 8, matrix: 16, curves: 88, size: 6232 } as const;

export interface HdrColourFit {
  deltaE: number;
  saturation: number;
  matrix: number[][];
  /** Three 256-entry curves over render values 0 to the trust ceiling. */
  curves: [number[], number[], number[]];
}

/**
 * The fitted HDR colour transform, without grading or encoding anything.
 *
 * The grade fits this itself; this is here so the tests that judge the fit against a
 * real file can reach it - a monotone curve, three channels leaving the fit domain
 * together, a deltaE inside the bound. Null when the fit declined.
 */
export function fitHdrColour(
  linear: ImageHandle,
  rawFilePath: string,
  options: HdrOptions,
  profile: FittedProfile | null,
): HdrColourFit | null {
  const S = shim();
  const size = Number(S.bb_hdr_colour_size());
  if (size !== HDR_COLOUR.size) {
    throw new Error(`BbHdrColour is ${size} bytes but this reader assumes ${HDR_COLOUR.size}`);
  }
  const raw = new Uint8Array(size);
  const status = S.bb_fit_hdr(
    linear.pointer,
    Buffer.from(`${rawFilePath}\0`),
    ptr(hdrOptionsBuffer(options)),
    profile == null ? null : ptr(profile.raw),
    ptr(raw),
  );
  if (status === 1) return null;
  if (status !== 0) throw new Error(`rawshim could not fit an HDR colour for ${rawFilePath}`);

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const curve = (channel: number): number[] =>
    Array.from({ length: 256 }, (_, i) => view.getFloat64(HDR_COLOUR.curves + (channel * 256 + i) * 8, true));
  return {
    deltaE: view.getFloat64(HDR_COLOUR.deltaE, true),
    saturation: view.getFloat64(HDR_COLOUR.saturation, true),
    matrix: [0, 1, 2].map((row) =>
      [0, 1, 2].map((col) => view.getFloat64(HDR_COLOUR.matrix + (row * 3 + col) * 8, true)),
    ),
    curves: [curve(0), curve(1), curve(2)],
  };
}

/**
 * The graded 16-bit samples the HDR encode would hand to ffmpeg.
 *
 * For the pin that holds this against the TypeScript it replaced. It copies the whole
 * frame, which is what the production path exists to avoid, so nothing else uses it.
 */
export function hdrGradedSamples(
  linear: ImageHandle,
  rawFilePath: string,
  options: HdrOptions,
  profile: FittedProfile | null,
): { width: number; height: number; data: Buffer } {
  const raw = hdrOptionsBuffer(options);
  const size = new Uint32Array(2);
  const data = takeBuffer(
    shim().bb_hdr_graded(
      linear.pointer,
      Buffer.from(`${rawFilePath}\0`),
      ptr(raw),
      profile == null ? null : ptr(profile.raw),
      ptr(size),
    ),
  );
  if (data == null) throw new Error(`rawshim could not grade ${rawFilePath}`);
  return { width: size[0]!, height: size[1]!, data };
}

/**
 * The camera's embedded JPEG preview, as bytes. Null when the file has none.
 *
 * Deliberately the one op that hands bytes over: its caller serves them to an HTTP
 * response unchanged. Anything that goes on to *decode* the preview wants
 * `decodeEmbedded`, which never brings it across.
 */
export function extractEmbedded(filePath: string): Buffer | null {
  return takeBuffer(shim().bb_extract_embedded(Buffer.from(`${filePath}\0`)));
}

/** Copies a `BbBuffer` out and releases it. Null in, null out. */
function takeBuffer(handle: Pointer | null): Buffer | null {
  if (!handle) return null;
  try {
    checkLayout();
    const head = new DataView(toArrayBuffer(handle, 0, BUFFER.size));
    const address = Number(head.getBigUint64(BUFFER.data, true));
    const length = Number(head.getBigUint64(BUFFER.len, true));
    // Copied because the allocation is released in the finally below, while the
    // bytes are handed on to a caller that outlives this frame.
    return Buffer.from(new Uint8Array(toArrayBuffer(address as never, 0, length)));
  } finally {
    shim().bb_buffer_free(handle);
  }
}

/**
 * The samples, copied into JS.
 *
 * The expensive way to use a handle, and the point of the handle API is that
 * almost nothing needs to: only the HDR path, whose encoder is ffmpeg rather than
 * libvips, and the HDR fit that reads the same pixels.
 */
export function pixels(image: ImageHandle): Buffer {
  const head = new DataView(toArrayBuffer(image.pointer, 0, IMAGE.size));
  const address = Number(head.getBigUint64(IMAGE.data, true));
  const length = Number(head.getBigUint64(IMAGE.len, true));
  return Buffer.from(new Uint8Array(toArrayBuffer(address as never, 0, length)));
}

// #[repr(C)] BbProfile: u32 has_distortion, u32 source, f64 crop, f64 delta_e,
// u32 knot_count, padding, f64 knots[64], u8 curves[768], f64 matrix[9].
const PROFILE = {
  hasDistortion: 0,
  source: 4,
  crop: 8,
  deltaE: 16,
  knotCount: 24,
  knots: 32,
  curves: 544,
  matrix: 1312,
  size: 1384,
} as const;

/** Per-channel tone curves then a 3x3 mix, which is the whole colour model. */
export interface ColourTransform {
  /** 256 entries each, indexed by 8-bit input. */
  curves: [Uint8Array, Uint8Array, Uint8Array];
  /** Applied after the curves; row-major, output channel by input channel. */
  matrix: number[][];
}

export interface FittedProfile {
  /** Radial knots in `SPLINE_UNIT`s, or null when no correction is needed. */
  distortion: number[] | null;
  /** Overall rescale accompanying the distortion. */
  crop: number;
  /** Where the geometry came from, for reporting and for cache keys. */
  distortionSource: 'none' | 'camera' | 'fitted';
  colour: ColourTransform;
  /** Held-out mean deltaE76 after the whole transform. */
  deltaE: number;
  /** The struct itself, kept so it can go straight back to `renderImage`. */
  raw: Uint8Array;
}

const SOURCES = ['none', 'camera', 'fitted'] as const;

function profileBuffer(): Uint8Array {
  const size = Number(shim().bb_profile_size());
  if (size !== PROFILE.size) {
    throw new Error(`BbProfile is ${size} bytes but this reader assumes ${PROFILE.size}; the offsets here need updating`);
  }
  return new Uint8Array(size);
}

/**
 * Fits the transform taking `render` to the camera's own JPEG in `rawFilePath`.
 *
 * Everything the fit needs comes off that path - the embedded preview and the
 * distortion spline the body recorded - and neither crosses the boundary.
 *
 * Null when there is no match worth applying, which is not an error: the caller
 * renders untransformed rather than shipping a bad grade.
 */
export function fitProfile(render: ImageHandle, rawFilePath: string): FittedProfile | null {
  const raw = profileBuffer();
  const status = shim().bb_fit(render.pointer, Buffer.from(`${rawFilePath}\0`), ptr(raw));
  return status === 1 ? null : readProfile(raw, status);
}

/**
 * `fitProfile` against a target the caller constructed rather than the file's own
 * preview. For the test that injects a known distortion and requires the fit to
 * recover it; nothing in the app uses it.
 */
export function fitProfileAgainst(
  render: ImageHandle,
  jpegBytes: Buffer,
  cameraKnots: number[] | null,
): FittedProfile | null {
  const raw = profileBuffer();
  const knots = new Float64Array(cameraKnots ?? []);
  const status = shim().bb_fit_against(
    render.pointer,
    jpegBytes,
    BigInt(jpegBytes.length),
    knots.length > 0 ? ptr(knots) : null,
    knots.length,
    ptr(raw),
  );
  return status === 1 ? null : readProfile(raw, status);
}

function readProfile(raw: Uint8Array, status: number): FittedProfile {
  if (status !== 0) throw new Error('rawshim could not fit a profile');

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = view.getUint32(PROFILE.knotCount, true);
  const curve = (channel: number): Uint8Array =>
    raw.slice(PROFILE.curves + channel * 256, PROFILE.curves + (channel + 1) * 256);
  return {
    distortion:
      view.getUint32(PROFILE.hasDistortion, true) === 1
        ? Array.from({ length: count }, (_, i) => view.getFloat64(PROFILE.knots + i * 8, true))
        : null,
    crop: view.getFloat64(PROFILE.crop, true),
    distortionSource: SOURCES[view.getUint32(PROFILE.source, true)] ?? 'none',
    colour: {
      curves: [curve(0), curve(1), curve(2)],
      matrix: [0, 1, 2].map((row) =>
        [0, 1, 2].map((column) => view.getFloat64(PROFILE.matrix + (row * 3 + column) * 8, true)),
      ),
    },
    deltaE: view.getFloat64(PROFILE.deltaE, true),
    raw,
  };
}

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
 * Decodes an encoded image (a JPEG, an AVIF) and applies its EXIF orientation,
 * fitting it to `longEdge` on the way. 0 leaves the size alone.
 *
 * For bytes that are already in hand for another reason - a rendition read off
 * disk to transcode. Anything reading a RAW's preview wants `decodeEmbedded`,
 * which never brings the JPEG across.
 */
export function decodeImage(bytes: Buffer, longEdge = 0): ImageHandle {
  return handleOf(shim().bb_decode_image(bytes, BigInt(bytes.length), longEdge), 'decode that image');
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
  const handle = shim().bb_encode_jpeg(image.pointer, longEdge, quality);
  if (!handle) throw new Error('rawshim could not encode a JPEG');
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

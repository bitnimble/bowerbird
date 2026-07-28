import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';

// LibRaw is loaded at runtime via FFI (the container ships libraw-dev). The C API
// (libraw/libraw_c_api.h) exposes plain functions + accessors, avoiding most
// struct-offset fragility; the one struct we read for pixels,
// libraw_processed_image_t, has a stable public layout. See DESIGN §10.4 / §11.1.
const LIB_CANDIDATES = ['libraw.so', 'libraw.so.23', 'libraw.so.20', 'libraw.dylib'];

const SYMBOLS = {
  libraw_init: { args: [FFIType.i32], returns: FFIType.ptr },
  libraw_open_file: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  libraw_unpack: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_dcraw_process: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_dcraw_make_mem_image: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  libraw_unpack_thumb: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_dcraw_make_mem_thumb: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  libraw_dcraw_clear_mem: { args: [FFIType.ptr], returns: FFIType.void },
  libraw_recycle: { args: [FFIType.ptr], returns: FFIType.void },
  libraw_close: { args: [FFIType.ptr], returns: FFIType.void },
  libraw_adjust_sizes_info_only: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_set_output_bps: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
  libraw_set_output_color: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
  libraw_set_gamma: { args: [FFIType.ptr, FFIType.i32, FFIType.f32], returns: FFIType.void },
  libraw_set_no_auto_bright: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
  libraw_set_user_mul: { args: [FFIType.ptr, FFIType.i32, FFIType.f32], returns: FFIType.void },
  libraw_get_cam_mul: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.f32 },
  libraw_set_demosaic: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.void },
  libraw_get_iwidth: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_get_iheight: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_get_imgother: { args: [FFIType.ptr], returns: FFIType.ptr },
  libraw_get_iparams: { args: [FFIType.ptr], returns: FFIType.ptr },
  libraw_get_lensinfo: { args: [FFIType.ptr], returns: FFIType.ptr },
  libraw_strerror: { args: [FFIType.i32], returns: FFIType.cstring },
} as const;

type LibRaw = ReturnType<typeof dlopen<typeof SYMBOLS>>['symbols'];

let cached: LibRaw | null = null;

function lib(): LibRaw {
  if (cached) return cached;
  let lastErr: unknown;
  for (const name of LIB_CANDIDATES) {
    try {
      cached = dlopen(name, SYMBOLS).symbols;
      return cached;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`could not load LibRaw (${LIB_CANDIDATES.join(', ')}): ${String(lastErr)}`);
}

function cpath(p: string): Uint8Array {
  return new TextEncoder().encode(`${p}\0`);
}

function check(L: LibRaw, code: number, step: string): void {
  if (code !== 0) throw new Error(`libraw ${step} failed: ${L.libraw_strerror(code)?.toString() ?? code}`);
}

export interface DecodedImage {
  width: number;
  height: number;
  channels: 3;
  // 8 for thumbnails, 16 for a full-depth export. sharp needs to be told which.
  depth: 8 | 16;
  data: Buffer; // interleaved RGB, already rotated to display orientation
}

// `output_color` values, which are LibRaw's own numbering for the render target
// and are NOT the LIBRAW_COLORSPACE_* enum (that one describes what the camera
// said its data was in).
const OUTPUT_COLOR = { srgb: 1, rec2020: 8 } as const;

// LibRaw's `user_qual`. The default is 3 (AHD); 2 is PPG, which on a 60MP frame
// demosaics in 544ms against AHD's 849ms for a mean difference of 0.46 of an 8-bit
// level - 0.18%, and every rendition is a downscale of at least 2.5x, so it is
// gone before anything is looked at. Measured on the same frame, 0 (linear) is
// slower than AHD rather than faster, and 1 (VNG) is 5.4s.
const DEMOSAIC_PPG = 2;

// What the pixels are in when the decode hands them back.
//   'srgb'            display-referred, sRGB primaries and transfer. Everything
//                     that ends up in an <img> wants this.
//   'rec2020-linear'  scene-referred, Rec.2020 primaries and no tone curve, for
//                     an HDR encode: the transfer is applied downstream, and
//                     highlights above diffuse white have to survive to get
//                     there. Auto-brightening is off for the same reason, since
//                     it normalises away the headroom that is the HDR signal.
export type OutputSpace = 'srgb' | 'rec2020-linear';

// libraw_processed_image_t: int type; u16 height,width,colors,bits; u32 data_size; u8 data[].
const IMG = { type: 0, height: 4, width: 6, colors: 8, bits: 10, dataSize: 12, data: 16 } as const;
const LIBRAW_IMAGE_JPEG = 1;

// ------------------------------------------------------------------ half size
//
// `half_size` makes LibRaw collapse each Bayer quad into one output pixel instead
// of interpolating: a quarter of the pixels, no demosaic, and a quarter of the
// bytes to copy out. On a 61MP frame that is 1592ms of decode down to 956ms, all
// of it from the demosaic (594ms to 128ms) and the copy (183ms to 46ms); the
// unpack is the raw decompression and does not move.
//
// It costs real detail - dark edges pick up a faint checkerboard - so it is only
// used when the halved frame still exceeds what the caller asked for, and never
// for a native-resolution rendition.
//
// There is no setter for it in the C API, so it has to be written into
// libraw_output_params_t by offset. Rather than hardcode one (it moves between
// builds), the struct is located at runtime through fields that *do* have setters:
// `output_bps` is found by writing sentinels through its setter and seeing which
// word follows, and `user_qual` then confirms the layout from the other side.
// Half_size sits at a fixed distance from both within the same struct, so two
// agreeing anchors mean the third address is right. If either check fails the
// decode simply runs full size.
const BPS_FROM_HALF_SIZE = 64; // offsetof(output_bps) - offsetof(half_size)
const QUAL_FROM_BPS = 16; // offsetof(user_qual) - offsetof(output_bps)
const PARAMS_SCAN_BYTES = 65536;

/** Offset of `params.output_bps` within libraw_data_t, or null if not pinned down. */
function findOutputBps(L: LibRaw, proc: Pointer): number | null {
  const view = new DataView(toArrayBuffer(proc, 0, PARAMS_SCAN_BYTES));
  let candidates: number[] = [];
  // Three distinct values: anything that tracks all of them is the field itself.
  for (const [index, sentinel] of [16, 14, 8].entries()) {
    L.libraw_set_output_bps(proc, sentinel);
    if (index === 0) {
      candidates = [];
      for (let offset = 0; offset + 4 <= PARAMS_SCAN_BYTES; offset += 4) {
        if (view.getInt32(offset, true) === sentinel) candidates.push(offset);
      }
    } else {
      candidates = candidates.filter((offset) => view.getInt32(offset, true) === sentinel);
    }
    if (candidates.length === 0) return null;
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Turns on half-size decoding, or reports that it could not be done safely.
 * Must be called before `unpack`.
 */
function enableHalfSize(L: LibRaw, proc: Pointer): boolean {
  const bps = findOutputBps(L, proc);
  if (bps == null || bps < BPS_FROM_HALF_SIZE) return false;

  // Second anchor from the other direction: if user_qual is where the struct says
  // it should be relative to output_bps, the layout is the one these offsets came
  // from, and half_size is too.
  const view = new DataView(toArrayBuffer(proc, 0, bps + QUAL_FROM_BPS + 4));
  for (const sentinel of [2, 3]) {
    L.libraw_set_demosaic(proc, sentinel);
    if (view.getInt32(bps + QUAL_FROM_BPS, true) !== sentinel) return false;
  }

  view.setInt32(bps - BPS_FROM_HALF_SIZE, 1, true);
  return true;
}

/** Long edge of the visible frame, read from `sizes` without decoding anything. */
function visibleLongEdge(proc: Pointer): number {
  const dv = sizesView(proc);
  // sizes begins ushort raw_height, raw_width, height, width.
  return Math.max(dv.getUint16(4, true), dv.getUint16(6, true));
}

function halveInsets(insets: Insets): Insets {
  return {
    left: Math.floor(insets.left / 2),
    top: Math.floor(insets.top / 2),
    right: Math.floor(insets.right / 2),
    bottom: Math.floor(insets.bottom / 2),
  };
}

// The camera's own JPEG rendering, embedded in the RAW. Extracting it needs no
// demosaic, so it is far faster than a render and carries the maker's colour
// treatment; the trade-off is whatever resolution the body chose to embed.
// Returns null when the file has no JPEG preview (some bodies embed a bitmap).
export function readEmbeddedJpeg(filePath: string): Buffer | null {
  const L = lib();
  const proc = L.libraw_init(0);
  if (!proc) throw new Error('libraw_init failed');

  try {
    check(L, L.libraw_open_file(proc, cpath(filePath)), 'open_file');
    if (L.libraw_unpack_thumb(proc) !== 0) return null;

    const err = new Int32Array(1);
    const thumb = L.libraw_dcraw_make_mem_thumb(proc, ptr(err));
    if (!thumb || err[0] !== 0) return null;

    try {
      const head = new DataView(toArrayBuffer(thumb, 0, IMG.data));
      if (head.getInt32(IMG.type, true) !== LIBRAW_IMAGE_JPEG) return null;
      const size = head.getUint32(IMG.dataSize, true);
      if (size === 0) return null;
      // Copy out of LibRaw-owned memory before it is freed.
      return Buffer.from(toArrayBuffer(thumb, IMG.data, size).slice(0));
    } finally {
      L.libraw_dcraw_clear_mem(thumb);
    }
  } finally {
    L.libraw_recycle(proc);
    L.libraw_close(proc);
  }
}

// LibRaw's default white balance is the camera's *daylight* table, not the
// multipliers the body actually metered, so a render of a tungsten-lit frame comes
// out visibly orange. Measured against the embedded JPEG on an ILCE-6300, using
// the as-shot values takes mean deltaE76 from 32.5 to 20.2, which is the single
// largest colour error in the pipeline.
//
// There is no `use_camera_wb` setter in the C API, so the values are copied across
// by hand. cam_mul is in camera-channel order (R, G1, B, G2) and normalising to G1
// keeps green at unity, which is what dcraw's -w does.
//
/**
 * As-shot multipliers normalised to green, or null when the file did not record a
 * usable set and LibRaw's default should stand.
 *
 * Every one of R, G1 and B has to be positive before any of them is applied: these
 * are written straight into `user_mul`, so a single zero or negative among them
 * would zero or invert that channel in the render, which is a worse outcome than
 * the wrong white balance this exists to fix.
 *
 * The fourth (G2) is the exception and must not be part of that test. A
 * three-colour camera legitimately reports it as 0, and dcraw substitutes green
 * for it downstream; rejecting on it would skip white balance entirely on exactly
 * those bodies. Substituting green here matches what LibRaw would do anyway,
 * without depending on it happening.
 */
export function cameraMultipliers(camMul: readonly number[]): [number, number, number, number] | null {
  const [red, green, blue, green2] = [camMul[0] ?? 0, camMul[1] ?? 0, camMul[2] ?? 0, camMul[3] ?? 0];
  if (!(red > 0) || !(green > 0) || !(blue > 0)) return null;
  return [red / green, 1, blue / green, (green2 > 0 ? green2 : green) / green];
}

function applyCameraWhiteBalance(L: LibRaw, proc: Pointer): void {
  const multipliers = cameraMultipliers([0, 1, 2, 3].map((i) => L.libraw_get_cam_mul(proc, i)));
  if (multipliers == null) return;
  for (let i = 0; i < 4; i += 1) L.libraw_set_user_mul(proc, i, multipliers[i]!);
}

export interface DecodeOptions {
  /**
   * Longest edge the caller is going to need.
   *
   * When the sensor is large enough that even a half-size decode clears this, that
   * is what runs: it is a great deal cheaper and the difference does not survive
   * the downscale to a rendition. Omit it, or pass 0, to always decode at full
   * size - which is what a native-resolution rendition requires.
   */
  atLeastLongEdge?: number;
}

// Decodes a RAW file to an upright RGB bitmap. Every LibRaw allocation is
// freed on all paths (mem-image, unpacked data, processor) per DESIGN §10.4.
export function decodeRaw(
  filePath: string,
  depth: 8 | 16 = 8,
  space: OutputSpace = 'srgb',
  options: DecodeOptions = {},
): DecodedImage {
  const L = lib();
  const proc = L.libraw_init(0);
  if (!proc) throw new Error('libraw_init failed');

  try {
    check(L, L.libraw_open_file(proc, cpath(filePath)), 'open_file');
    // Read before unpack/process, which overwrite the size fields.
    let insets = rotateInsets(readCropInsets(proc), readFlip(proc));

    // Only worth it when halving still leaves more than the caller needs. A 24MP
    // frame halves to about 3000px, under the 3840 a full-size rendition wants, so
    // it decodes whole; a 61MP one halves to 4864 and does not.
    const wanted = options.atLeastLongEdge ?? 0;
    if (wanted > 0 && Math.floor(visibleLongEdge(proc) / 2) >= wanted && enableHalfSize(L, proc)) {
      insets = halveInsets(insets);
    }

    applyCameraWhiteBalance(L, proc);
    L.libraw_set_demosaic(proc, DEMOSAIC_PPG);
    if (space === 'rec2020-linear') {
      L.libraw_set_output_color(proc, OUTPUT_COLOR.rec2020);
      // gamma[0] is the power and gamma[1] the toe slope; 1/1 is the identity
      // curve, so the samples stay proportional to the light that made them.
      L.libraw_set_gamma(proc, 0, 1);
      L.libraw_set_gamma(proc, 1, 1);
      L.libraw_set_no_auto_bright(proc, 1);
    } else {
      // A browser can only display a known space, and a PNG with no profile is
      // taken as sRGB, so both depths render into it.
      L.libraw_set_output_color(proc, OUTPUT_COLOR.srgb);
    }
    L.libraw_set_output_bps(proc, depth);
    check(L, L.libraw_unpack(proc), 'unpack');
    check(L, L.libraw_dcraw_process(proc), 'dcraw_process');

    const err = new Int32Array(1);
    const image = L.libraw_dcraw_make_mem_image(proc, ptr(err));
    if (!image || err[0] !== 0) throw new Error(`make_mem_image failed (${err[0]})`);

    try {
      const head = new DataView(toArrayBuffer(image, 0, IMG.data));
      const height = head.getUint16(IMG.height, true);
      const width = head.getUint16(IMG.width, true);
      const colors = head.getUint16(IMG.colors, true);
      const bits = head.getUint16(IMG.bits, true);
      const dataSize = head.getUint32(IMG.dataSize, true);
      if (colors !== 3 || bits !== depth) throw new Error(`unexpected image format: colors=${colors} bits=${bits}`);
      // A view over LibRaw's own buffer, valid only until clear_mem below. Copying
      // and cropping happen in one pass out of it: a 60MP frame is ~190MB, and
      // copying it whole and then copying the crop out of that spent ~250ms per
      // decode moving bytes twice.
      const source = new Uint8Array(toArrayBuffer(image, IMG.data, dataSize));
      return copyCropped(source, width, height, depth, insets);
    } finally {
      L.libraw_dcraw_clear_mem(image);
    }
  } finally {
    L.libraw_recycle(proc);
    L.libraw_close(proc);
  }
}

export interface RawHeader {
  width: number; // display/upright (post flip-adjust)
  height: number;
  orientation: number; // LibRaw sizes.flip code (0/3/5/6); 0 if unreadable
  dateTaken: string | null;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutterSpeed: number | null; // seconds (1/250s -> 0.004)
  aperture: number | null; // f-number
  focalLength: number | null; // mm
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
}

// LibRaw leaves these at 0 when the camera didn't record them, and a negative or
// absurd value means the struct layout drifted. Either way, report "unknown"
// rather than printing 0 as if the shot were taken at f/0.
function positiveOrNull(value: number, max: number): number | null {
  return Number.isFinite(value) && value > 0 && value < max ? value : null;
}

// libraw_data_t (x86-64): ushort(*image)[4] (8B) then libraw_image_sizes_t at
// offset 8. Within sizes: ushorts raw_h/raw_w/h/w/top/left/ih/iw (16B), u32
// raw_pitch (@16), double pixel_aspect (@24), int flip (@32), int mask[8][4]
// (@36), ushort raw_aspect (@164), raw_inset_crops[2] (@166, 4 ushorts each).
// Validated against real ARWs from four bodies; every read is range-guarded.
const SIZES = {
  base: 8,
  readSize: 184,
  rawHeight: 0,
  rawWidth: 2,
  flip: 32,
  cropLeft: 166,
  cropTop: 168,
  cropWidth: 170,
  cropHeight: 172,
} as const;

const UNSET = 65535; // LibRaw's "the file didn't state this"

function sizesView(proc: Pointer): DataView {
  return new DataView(toArrayBuffer(proc, SIZES.base, SIZES.readSize));
}

function readFlip(proc: Pointer): number {
  const flip = sizesView(proc).getInt32(SIZES.flip, true);
  return flip >= 0 && flip <= 8 ? flip : 0;
}

// Rows/columns of the raw frame that lie outside the camera's stated visible
// image, in sensor orientation.
interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const NO_INSETS: Insets = { left: 0, top: 0, right: 0, bottom: 0 };

// Some bodies (the ILCE-7CR among them) report masked border columns as part of
// LibRaw's "visible" area, so decoding it verbatim bakes black bars into the
// thumbnail. raw_inset_crops[0] is the frame the camera itself says is the
// picture; where the file states one, that is what should be shown.
function readCropInsets(proc: Pointer): Insets {
  const dv = sizesView(proc);
  const u16 = (offset: number): number => dv.getUint16(offset, true);
  const rawWidth = u16(SIZES.rawWidth);
  const rawHeight = u16(SIZES.rawHeight);
  const left = u16(SIZES.cropLeft);
  const top = u16(SIZES.cropTop);
  const width = u16(SIZES.cropWidth);
  const height = u16(SIZES.cropHeight);

  // Without an origin the frame cannot be placed, and a crop that doesn't fit
  // the raw frame means the layout drifted. Either way, don't crop.
  if (left === UNSET || top === UNSET || width === 0 || height === 0) return NO_INSETS;
  if (left + width > rawWidth || top + height > rawHeight) return NO_INSETS;
  return { left, top, right: rawWidth - left - width, bottom: rawHeight - top - height };
}

// dcraw_process emits an upright image, so sensor-space margins arrive rotated
// by the same flip. Verified against the ILCE-7CR (flip 6), where the wrong
// permutation moves the black bar to another edge rather than removing it.
function rotateInsets(insets: Insets, flip: number): Insets {
  switch (flip) {
    case 3: // 180
      return { left: insets.right, top: insets.bottom, right: insets.left, bottom: insets.top };
    case 5: // 90 CCW
      return { left: insets.top, top: insets.right, right: insets.bottom, bottom: insets.left };
    case 6: // 90 CW
      return { left: insets.bottom, top: insets.left, right: insets.top, bottom: insets.right };
    default:
      return insets;
  }
}

/**
 * The decoded frame copied out of LibRaw's buffer, with any masked border removed
 * on the way. One pass: `source` is a view over memory that is about to be freed,
 * so it has to be copied regardless, and cropping during that copy is free.
 */
function copyCropped(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  depth: 8 | 16,
  insets: Insets,
): DecodedImage {
  const width = sourceWidth - insets.left - insets.right;
  const height = sourceHeight - insets.top - insets.bottom;
  const pixel = 3 * (depth / 8);
  if (width <= 0 || height <= 0 || (insets.left | insets.top | insets.right | insets.bottom) === 0) {
    return { width: sourceWidth, height: sourceHeight, channels: 3, depth, data: Buffer.from(source) };
  }

  const stride = sourceWidth * pixel;
  const rowBytes = width * pixel;
  const out = Buffer.allocUnsafe(width * height * pixel);
  for (let row = 0; row < height; row += 1) {
    const from = (row + insets.top) * stride + insets.left * pixel;
    out.set(source.subarray(from, from + rowBytes), row * rowBytes);
  }
  return { width, height, channels: 3, depth, data: out };
}

/**
 * Box-average downscale, in whatever light the samples are already in.
 *
 * On a scene-linear decode that means averaging light, which is the only correct
 * way to shrink one: averaging after a transfer curve has been applied averages
 * code values instead, and darkens. Every source pixel contributes exactly once,
 * so there is no ringing either.
 *
 * Only downscales; asking for a larger size returns the image untouched, since
 * this exists to avoid work rather than to invent detail.
 */
export function resizeRgb(image: DecodedImage, width: number, height: number): DecodedImage {
  if (width >= image.width || height >= image.height) return image;

  const wide = image.depth === 16;
  const src = wide
    ? new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2)
    : new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const out = Buffer.allocUnsafe(width * height * 3 * (image.depth / 8));
  const dst = wide
    ? new Uint16Array(out.buffer, out.byteOffset, out.byteLength / 2)
    : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);

  const xs = image.width / width;
  const ys = image.height / height;
  for (let dy = 0; dy < height; dy += 1) {
    const y0 = Math.floor(dy * ys);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * ys));
    for (let dx = 0; dx < width; dx += 1) {
      const x0 = Math.floor(dx * xs);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * xs));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y += 1) {
        const row = y * image.width;
        for (let x = x0; x < x1; x += 1) {
          const i = (row + x) * 3;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (dy * width + dx) * 3;
      dst[o] = Math.round(r / n);
      dst[o + 1] = Math.round(g / n);
      dst[o + 2] = Math.round(b / n);
    }
  }
  return { width, height, channels: 3, depth: image.depth, data: out };
}

// libraw_imgother_t (LibRaw 0.21, x86-64): float iso,shutter,aperture,focal (16B),
// time_t timestamp (8B @16), u32 shot_order (@24), u32 gpsdata[32] (@28),
// libraw_gps_info_t parsed_gps (@156). Within parsed_gps: float latitude[3] @0,
// longitude[3] @12; char latref @41, longref @42, gpsparsed @44.
// Offsets are validated against the installed LibRaw in the container; reads are
// plausibility-guarded so a layout mismatch degrades to null, never garbage.
const OTHER = { iso: 0, shutter: 4, aperture: 8, focal: 12, timestamp: 16, gps: 156, readSize: 208 } as const;
const GPS = { lat: 156, lon: 168, latref: 197, longref: 198, parsed: 200 } as const;

// libraw_iparams_t: char guard[4], then make/model/software/normalized_make/
// normalized_model, each char[64]. libraw_lensinfo_t: 5 floats, char LensMake[128]
// @20, char Lens[128] @148. Both verified against real ARWs from three bodies.
const IPARAMS = { make: 4, model: 68, normalizedMake: 196, normalizedModel: 260, field: 64, readSize: 324 } as const;
const LENS = { lens: 148, field: 128, readSize: 276 } as const;

// A fixed-width NUL-padded C string. Blank means the camera didn't record it,
// which is "unknown", not an empty name worth storing.
function cstr(dv: DataView, offset: number, size: number): string | null {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + offset, size);
  const end = bytes.indexOf(0);
  const text = new TextDecoder().decode(bytes.subarray(0, end === -1 ? size : end)).trim();
  return text === '' || /^-+$/.test(text) ? null : text;
}

function dms(dv: DataView, off: number): number {
  return dv.getFloat32(off, true) + dv.getFloat32(off + 4, true) / 60 + dv.getFloat32(off + 8, true) / 3600;
}

// EXIF DateTimeOriginal carries no timezone, and LibRaw turns it into a time_t
// with mktime(), i.e. it reads the camera's wall clock as *server-local* time.
// Taking that instant as UTC would slide every capture date by the server's
// offset (and by an hour across DST), so read the components back in the same
// local zone mktime used and re-encode them as UTC. The stored value is then the
// wall clock the camera wrote, on any machine.
function wallClockIso(epochSeconds: number): string {
  const local = new Date(epochSeconds * 1000);
  return new Date(
    Date.UTC(
      local.getFullYear(),
      local.getMonth(),
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
      local.getSeconds(),
    ),
  ).toISOString();
}

// Reads dimensions (always) plus best-effort capture time and GPS, without
// decoding pixels (DESIGN §11.1). Returns UTC-normalized dateTaken.
export function readRawHeader(filePath: string): RawHeader {
  const L = lib();
  const proc = L.libraw_init(0);
  if (!proc) throw new Error('libraw_init failed');
  try {
    check(L, L.libraw_open_file(proc, cpath(filePath)), 'open_file');
    const orientation = readFlip(proc); // sizes.flip is set at open; read before adjust
    // The stored dimensions must describe the picture that gets thumbnailed, so
    // they carry the same crop the decode applies.
    const insets = rotateInsets(readCropInsets(proc), orientation);
    L.libraw_adjust_sizes_info_only(proc);
    const width = L.libraw_get_iwidth(proc) - insets.left - insets.right;
    const height = L.libraw_get_iheight(proc) - insets.top - insets.bottom;

    let dateTaken: string | null = null;
    let latitude: number | null = null;
    let longitude: number | null = null;
    let iso: number | null = null;
    let shutterSpeed: number | null = null;
    let aperture: number | null = null;
    let focalLength: number | null = null;

    // LibRaw's normalized_* are its cleaned-up names ("ILCE-7CR" rather than a
    // vendor string with firmware glued on), so prefer them where present.
    const iparams = L.libraw_get_iparams(proc);
    const ip = iparams == null ? null : new DataView(toArrayBuffer(iparams, 0, IPARAMS.readSize));
    const cameraMake =
      ip == null ? null : (cstr(ip, IPARAMS.normalizedMake, IPARAMS.field) ?? cstr(ip, IPARAMS.make, IPARAMS.field));
    const cameraModel =
      ip == null ? null : (cstr(ip, IPARAMS.normalizedModel, IPARAMS.field) ?? cstr(ip, IPARAMS.model, IPARAMS.field));

    const lensinfo = L.libraw_get_lensinfo(proc);
    const lensModel =
      lensinfo == null ? null : cstr(new DataView(toArrayBuffer(lensinfo, 0, LENS.readSize)), LENS.lens, LENS.field);

    const other = L.libraw_get_imgother(proc);
    if (other) {
      const dv = new DataView(toArrayBuffer(other, 0, OTHER.readSize));
      const secs = Number(dv.getBigInt64(OTHER.timestamp, true));
      if (secs > 631152000 && secs < 4102444800) dateTaken = wallClockIso(secs);

      // Bounds are "no camera reports this", not physical limits: ISO 4 million,
      // a 1-hour exposure, f/256 and a 10m lens are all past anything real.
      iso = positiveOrNull(dv.getFloat32(OTHER.iso, true), 4_000_000);
      shutterSpeed = positiveOrNull(dv.getFloat32(OTHER.shutter, true), 3600);
      aperture = positiveOrNull(dv.getFloat32(OTHER.aperture, true), 256);
      focalLength = positiveOrNull(dv.getFloat32(OTHER.focal, true), 10_000);

      if (dv.getUint8(GPS.parsed) === 1) {
        const lat = dms(dv, GPS.lat) * (dv.getUint8(GPS.latref) === 0x53 ? -1 : 1); // 'S'
        const lon = dms(dv, GPS.lon) * (dv.getUint8(GPS.longref) === 0x57 ? -1 : 1); // 'W'
        if (Number.isFinite(lat) && Math.abs(lat) <= 90) latitude = lat;
        if (Number.isFinite(lon) && Math.abs(lon) <= 180) longitude = lon;
      }
    }

    return {
      width,
      height,
      orientation,
      dateTaken,
      latitude,
      longitude,
      iso,
      shutterSpeed,
      aperture,
      focalLength,
      cameraMake,
      cameraModel,
      lensModel,
    };
  } finally {
    L.libraw_recycle(proc);
    L.libraw_close(proc);
  }
}

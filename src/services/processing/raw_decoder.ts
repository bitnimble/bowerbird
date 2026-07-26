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
  data: Buffer; // interleaved 8-bit RGB, already rotated to display orientation
}

// libraw_processed_image_t: int type; u16 height,width,colors,bits; u32 data_size; u8 data[].
const IMG = { type: 0, height: 4, width: 6, colors: 8, bits: 10, dataSize: 12, data: 16 } as const;
const LIBRAW_IMAGE_JPEG = 1;

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

// Decodes a RAW file to an upright 8-bit RGB bitmap. Every LibRaw allocation is
// freed on all paths (mem-image, unpacked data, processor) per DESIGN §10.4.
export function decodeRaw(filePath: string): DecodedImage {
  const L = lib();
  const proc = L.libraw_init(0);
  if (!proc) throw new Error('libraw_init failed');

  try {
    check(L, L.libraw_open_file(proc, cpath(filePath)), 'open_file');
    // Read before unpack/process, which overwrite the size fields.
    const insets = rotateInsets(readCropInsets(proc), readFlip(proc));
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
      if (colors !== 3 || bits !== 8) throw new Error(`unexpected image format: colors=${colors} bits=${bits}`);
      // Copy out of LibRaw-owned memory before it is freed.
      const data = Buffer.from(toArrayBuffer(image, IMG.data, dataSize).slice(0));
      return cropRgb({ width, height, channels: 3, data }, insets);
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

function cropRgb(image: DecodedImage, insets: Insets): DecodedImage {
  const width = image.width - insets.left - insets.right;
  const height = image.height - insets.top - insets.bottom;
  if (width <= 0 || height <= 0 || (insets.left | insets.top | insets.right | insets.bottom) === 0) return image;

  const stride = image.width * 3;
  const out = Buffer.allocUnsafe(width * height * 3);
  for (let row = 0; row < height; row++) {
    const from = (row + insets.top) * stride + insets.left * 3;
    image.data.copy(out, row * width * 3, from, from + width * 3);
  }
  return { width, height, channels: 3, data: out };
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

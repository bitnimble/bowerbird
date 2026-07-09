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
  libraw_dcraw_clear_mem: { args: [FFIType.ptr], returns: FFIType.void },
  libraw_recycle: { args: [FFIType.ptr], returns: FFIType.void },
  libraw_close: { args: [FFIType.ptr], returns: FFIType.void },
  libraw_adjust_sizes_info_only: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_get_iwidth: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_get_iheight: { args: [FFIType.ptr], returns: FFIType.i32 },
  libraw_get_imgother: { args: [FFIType.ptr], returns: FFIType.ptr },
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
const IMG = { height: 4, width: 6, colors: 8, bits: 10, dataSize: 12, data: 16 } as const;

// Decodes a RAW file to an upright 8-bit RGB bitmap. Every LibRaw allocation is
// freed on all paths (mem-image, unpacked data, processor) per DESIGN §10.4.
export function decodeRaw(filePath: string): DecodedImage {
  const L = lib();
  const proc = L.libraw_init(0);
  if (!proc) throw new Error('libraw_init failed');

  try {
    check(L, L.libraw_open_file(proc, cpath(filePath)), 'open_file');
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
      return { width, height, channels: 3, data };
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
}

// libraw_data_t (x86-64): ushort(*image)[4] (8B) then libraw_image_sizes_t at
// offset 8. Within sizes: ushorts raw_h/raw_w/h/w/top/left/ih/iw (16B), u32
// raw_pitch (@16), double pixel_aspect (@24), int flip (@32). So flip is at
// proc + 8 + 32 = 40. Validated against a real ARW; guarded to a plausible range.
const FLIP_OFFSET = 40;

function readFlip(proc: Pointer): number {
  const flip = new DataView(toArrayBuffer(proc, FLIP_OFFSET, 4)).getInt32(0, true);
  return flip >= 0 && flip <= 8 ? flip : 0;
}

// libraw_imgother_t (LibRaw 0.21, x86-64): float iso,shutter,aperture,focal (16B),
// time_t timestamp (8B @16), u32 shot_order (@24), u32 gpsdata[32] (@28),
// libraw_gps_info_t parsed_gps (@156). Within parsed_gps: float latitude[3] @0,
// longitude[3] @12; char latref @41, longref @42, gpsparsed @44.
// Offsets are validated against the installed LibRaw in the container; reads are
// plausibility-guarded so a layout mismatch degrades to null, never garbage.
const OTHER = { timestamp: 16, gps: 156, readSize: 208 } as const;
const GPS = { lat: 156, lon: 168, latref: 197, longref: 198, parsed: 200 } as const;

function dms(dv: DataView, off: number): number {
  return dv.getFloat32(off, true) + dv.getFloat32(off + 4, true) / 60 + dv.getFloat32(off + 8, true) / 3600;
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
    L.libraw_adjust_sizes_info_only(proc);
    const width = L.libraw_get_iwidth(proc);
    const height = L.libraw_get_iheight(proc);

    let dateTaken: string | null = null;
    let latitude: number | null = null;
    let longitude: number | null = null;

    const other = L.libraw_get_imgother(proc);
    if (other) {
      const dv = new DataView(toArrayBuffer(other, 0, OTHER.readSize));
      const secs = Number(dv.getBigInt64(OTHER.timestamp, true));
      if (secs > 631152000 && secs < 4102444800) dateTaken = new Date(secs * 1000).toISOString();

      if (dv.getUint8(GPS.parsed) === 1) {
        const lat = dms(dv, GPS.lat) * (dv.getUint8(GPS.latref) === 0x53 ? -1 : 1); // 'S'
        const lon = dms(dv, GPS.lon) * (dv.getUint8(GPS.longref) === 0x57 ? -1 : 1); // 'W'
        if (Number.isFinite(lat) && Math.abs(lat) <= 90) latitude = lat;
        if (Number.isFinite(lon) && Math.abs(lon) <= 180) longitude = lon;
      }
    }

    return { width, height, orientation, dateTaken, latitude, longitude };
  } finally {
    L.libraw_recycle(proc);
    L.libraw_close(proc);
  }
}

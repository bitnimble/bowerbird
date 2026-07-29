import { extractEmbedded, decodeRawImage, freeImage, pixels, readHeaderFields } from './rawshim_ops';

// The RAW file's own metadata and its embedded preview, both by way of
// `native/rawshim` (DESIGN §10.4 / §11.1).
//
// Nothing here reaches into a LibRaw struct any more. It used to: six tables of
// hardcoded byte offsets into five of them, one reached by assuming where `sizes`
// sits inside `libraw_data_t`. The offsets were right and were checked against real
// files from several bodies, but nothing kept them right, and the failure would have
// been a silent one - a photo dated 1970, or every rendition sideways. bindgen
// resolves the fields in Rust from the headers the runtime library was built from.

export interface DecodedImage {
  width: number;
  height: number;
  channels: 3;
  // 8 for renditions, 16 for a full-depth export.
  depth: 8 | 16;
  data: Buffer; // interleaved RGB, already rotated to display orientation
}

// What the pixels are in when the decode hands them back.
//   'srgb'            display-referred, sRGB primaries and transfer. Everything
//                     that ends up in an <img> wants this.
//   'rec2020-linear'  scene-referred, Rec.2020 primaries and no tone curve, for
//                     an HDR encode: the transfer is applied downstream, and
//                     highlights above diffuse white have to survive to get
//                     there. Auto-brightening is off for the same reason, since
//                     it normalises away the headroom that is the HDR signal.
export type OutputSpace = 'srgb' | 'rec2020-linear';

/**
 * The camera's own JPEG rendering, embedded in the RAW, handed over as bytes.
 *
 * Extracting it needs no demosaic, so it is far faster than a render and carries
 * the maker's colour treatment; the trade-off is whatever resolution the body
 * chose to embed. Null when the file has no JPEG preview (some bodies embed a
 * bitmap, some nothing).
 *
 * Only for serving the bytes onward unchanged. Anything that goes on to decode the
 * preview wants `decodeEmbedded`, which keeps it out of this process entirely.
 */
export function readEmbeddedJpeg(filePath: string): Buffer | null {
  return extractEmbedded(filePath);
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

/**
 * Decodes a RAW file to an upright RGB bitmap, via the Rust wrapper
 * (`native/rawshim`, and see `rawshim.ts` for why).
 *
 * As-shot white balance, the PPG demosaic, the half-size decision and the
 * masked-border crop all happen in there now: they are one job, and splitting them
 * across an FFI boundary meant reaching into LibRaw's params struct from
 * TypeScript to set a field the C API does not expose.
 *
 * Copies the samples out, and nothing in the app does that any more: every pixel path
 * now ends in Rust. This is here for the tests that compare a decode against what was
 * written, which is the one thing that genuinely needs the samples on this side.
 * Production wants `decodeRawImage`, which leaves them where they are.
 */
export function decodeRaw(
  filePath: string,
  depth: 8 | 16 = 8,
  space: OutputSpace = 'srgb',
  options: DecodeOptions = {},
): DecodedImage {
  const image = decodeRawImage(filePath, depth, space, options.atLeastLongEdge ?? 0);
  try {
    return { width: image.width, height: image.height, channels: 3, depth, data: pixels(image) };
  } finally {
    freeImage(image);
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

// EXIF DateTimeOriginal carries no timezone, and LibRaw turns it into a time_t
// with mktime(), i.e. it reads the camera's wall clock as *server-local* time.
// Taking that instant as UTC would slide every capture date by the server's
// offset (and by an hour across DST), so read the components back in the same
// local zone mktime used and re-encode them as UTC. The stored value is then the
// wall clock the camera wrote, on any machine.
//
// Stays in TypeScript deliberately: this is date semantics, not struct access, and
// it has to run in the same process whose local zone mktime was resolved against.
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
//
// Every field comes from `bb_read_header`, which resolves them from LibRaw's own
// typed structs. This used to read five of those structs from here at hardcoded
// byte offsets - including one reached by assuming where `sizes` sits inside
// `libraw_data_t` - which is the same guess that moved the decode into Rust.
export function readRawHeader(filePath: string): RawHeader {
  const fields = readHeaderFields(filePath);
  return {
    width: fields.width,
    height: fields.height,
    orientation: fields.orientation,
    dateTaken: fields.timestamp == null ? null : wallClockIso(fields.timestamp),
    latitude: fields.latitude,
    longitude: fields.longitude,
    iso: fields.iso,
    shutterSpeed: fields.shutterSpeed,
    aperture: fields.aperture,
    focalLength: fields.focalLength,
    cameraMake: fields.cameraMake,
    cameraModel: fields.cameraModel,
    lensModel: fields.lensModel,
  };
}

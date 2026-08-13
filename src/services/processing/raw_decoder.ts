import { extractEmbedded, readHeaderFields } from './rawshim_ops';

// The RAW file's own metadata and its embedded preview, both by way of
// `native/rawshim` (DESIGN §10.4 / §11.1).
//
// Nothing here reaches into a C struct any more. It used to: six tables of hardcoded byte
// offsets into five of them, one reached by assuming where another sat inside a sixth. The
// offsets were right and were checked against real files from several bodies, but nothing
// kept them right, and the failure would have been a silent one - a photo dated 1970, or
// every rendition sideways. The fields are named in Rust now.

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

export interface RawHeader {
  width: number; // display/upright (post flip-adjust)
  height: number;
  orientation: number; // EXIF orientation, 1 to 8; 0 if unreadable
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

// EXIF DateTimeOriginal carries no timezone, and `bb_read_header` reads it as UTC, so the
// wall clock the camera wrote is already what these seconds mean and formatting them is
// the whole job.
//
// It was a round trip through the server's own zone until the header moved off LibRaw:
// `mktime` resolved that string against local time, and undoing it here was the only way
// to get the same date on every machine. Nothing calls `mktime` now, and the round trip
// had become the thing introducing the shift - a server at +10 dated an evening shot to
// the following day.
export function wallClockIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

// Reads dimensions (always) plus best-effort capture time and GPS, without
// decoding pixels (DESIGN §11.1). Returns UTC-normalized dateTaken.
//
// Every field comes from `bb_read_header`. This used to read five C structs from here at
// hardcoded byte offsets - including one reached by assuming where another sat inside a
// sixth - which is the same guess that moved the decode into Rust.
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

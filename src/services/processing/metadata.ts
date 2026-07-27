import { stat } from 'node:fs/promises';
import { readCaptureOffset } from './exif_zone';
import { readRawHeader } from './raw_decoder';

// Stage 1 reads every supported file with the LibRaw header parser (no pixel
// decode). See DESIGN §11.

export interface FileMetadata {
  width: number; // display/upright width (post-flip)
  height: number; // display/upright height (post-flip)
  colorSpace: string;
  orientation: number; // LibRaw flip orientation code; informational + hash input only
  dateTaken: string | null; // the camera's wall clock, as a Z string (§11.1)
  // What zone that wall clock was written in, "+11:00", or null from a body that
  // recorded none. Read straight from EXIF: LibRaw does not expose it.
  dateTakenOffset: string | null;
  latitude: number | null;
  longitude: number | null;
  iso: number | null;
  shutterSpeed: number | null; // seconds
  aperture: number | null; // f-number
  focalLength: number | null; // mm
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  mtime: string; // filesystem mtime, ISO datetime
  fileSize: number; // bytes
}

export async function extractMetadata(filePath: string): Promise<FileMetadata> {
  const stats = await stat(filePath);
  const header = readRawHeader(filePath);
  // A second read of the same file, because the two answers come from different
  // places: LibRaw for everything it parses, the raw EXIF for the one tag it
  // does not expose. Bounded to the header, so it costs a page or two.
  const dateTakenOffset = await readCaptureOffset(filePath);
  return {
    width: header.width,
    height: header.height,
    // Stage 1 constant: LibRaw has no stable accessor for the camera's source
    // color space, and we always decode to sRGB, so this is the sRGB output space
    // (a fixed, informational hash input; see DESIGN §9.2/§11.1).
    colorSpace: 'sRGB',
    orientation: header.orientation,
    dateTaken: header.dateTaken,
    dateTakenOffset,
    latitude: header.latitude,
    longitude: header.longitude,
    iso: header.iso,
    shutterSpeed: header.shutterSpeed,
    aperture: header.aperture,
    focalLength: header.focalLength,
    cameraMake: header.cameraMake,
    cameraModel: header.cameraModel,
    lensModel: header.lensModel,
    mtime: stats.mtime.toISOString(),
    fileSize: stats.size,
  };
}

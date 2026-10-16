import { stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { CaptureSequence } from '../../../schemas/capture_sequence';
import { readCaptureOffset } from './exif_zone';
import { readRawHeader, type RawHeader } from '../rawshim/raw_decoder';

// Stage 1 reads every supported file with the native header parser (no pixel
// decode). See DESIGN §11.

export interface FileMetadata {
  width: number; // display/upright width (post-flip)
  height: number; // display/upright height (post-flip)
  orientation: number; // EXIF orientation, 1 to 8; informational + hash input only
  dateTaken: string | null; // the camera's wall clock, as a Z string (§11.1)
  // What zone that wall clock was written in, "+11:00", or null from a body that
  // recorded none. Read straight from EXIF: the header parser does not carry it.
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
  sequence: CaptureSequence | null;
  mtime: string; // filesystem mtime, ISO datetime
  fileSize: number; // bytes
  /** Read off the device's media index rather than the file, so the tile pass reads the header. */
  provisional?: boolean;
  /** Set only where the index entry matches the file's size. */
  mediaImageId?: number;
}

/** What a header read says about a photograph, without the file's own size and time. */
export type HeaderMetadata = Omit<
  FileMetadata,
  'mtime' | 'fileSize' | 'provisional' | 'mediaImageId'
>;

export async function extractMetadata(filePath: string): Promise<FileMetadata> {
  const stats = await stat(filePath);
  const header = readRawHeader(filePath);
  // A second read of the same file, because the two answers come from different
  // places: `bb_read_header` for everything it parses, the raw EXIF for the one
  // tag it does not carry. Bounded to the header, so it costs a page or two.
  const dateTakenOffset = await readCaptureOffset(filePath);
  return fileMetadata(header, dateTakenOffset, stats);
}

function fileMetadata(
  header: RawHeader,
  dateTakenOffset: string | null,
  stats: Stats,
): FileMetadata {
  return {
    width: header.width,
    height: header.height,
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
    sequence: header.sequence,
    mtime: stats.mtime.toISOString(),
    fileSize: stats.size,
  };
}

import type { CaptureSequence } from '../../../schemas/capture_sequence';
import { readCaptureOffset } from './exif_zone';
import { readRawHeader } from '../rawshim/raw_decoder';

// The native header parser (no pixel decode). See DESIGN §11.

export interface FileMetadata {
  width: number; // display/upright width (post-flip); 0 until a provisional row's header is read
  height: number; // display/upright height (post-flip); 0 until a provisional row's header is read
  orientation: number; // EXIF orientation, 1 to 8; informational only
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
  /** Set only where the index entry matches the file's size. */
  mediaImageId?: number;
}

export type HeaderMetadata = Omit<FileMetadata, 'mtime' | 'fileSize' | 'mediaImageId'>;

export async function extractMetadata(filePath: string): Promise<HeaderMetadata> {
  const header = readRawHeader(filePath);
  // A second read of the same file, because the two answers come from different
  // places: `bb_read_header` for everything it parses, the raw EXIF for the one
  // tag it does not carry. Bounded to the header, so it costs a page or two.
  return { ...header, dateTakenOffset: await readCaptureOffset(filePath) };
}

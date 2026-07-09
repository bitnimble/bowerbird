import { stat } from 'node:fs/promises';
import { readRawHeader } from './raw_decoder';

// Per-format metadata extraction. Stage 1 dispatches every supported file to the
// LibRaw header parser (no pixel decode). See DESIGN §11.

export interface FileMetadata {
  width: number; // display/upright width (post-flip)
  height: number; // display/upright height (post-flip)
  colorSpace: string;
  orientation: number; // LibRaw flip orientation code; informational + hash input only
  dateTaken: string | null; // ISO datetime, UTC-normalized
  latitude: number | null;
  longitude: number | null;
  mtime: string; // filesystem mtime, ISO datetime
  fileSize: number; // bytes
}

export async function extractMetadata(filePath: string): Promise<FileMetadata> {
  return extractArwMetadata(filePath);
}

async function extractArwMetadata(filePath: string): Promise<FileMetadata> {
  const stats = await stat(filePath);
  const header = readRawHeader(filePath);
  return {
    width: header.width,
    height: header.height,
    // Stage 1 constant: LibRaw has no stable accessor for the camera's source
    // color space, and we always decode to sRGB, so this is the sRGB output space
    // (a fixed, informational hash input; see DESIGN §9.2/§11.1).
    colorSpace: 'sRGB',
    orientation: header.orientation,
    dateTaken: header.dateTaken,
    latitude: header.latitude,
    longitude: header.longitude,
    mtime: stats.mtime.toISOString(),
    fileSize: stats.size,
  };
}

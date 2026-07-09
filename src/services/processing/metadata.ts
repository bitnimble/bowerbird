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
    // LibRaw processes to sRGB by default; display dims already encode the flip,
    // so orientation is retained only as informational + a stable hash input.
    colorSpace: 'sRGB',
    orientation: 0,
    dateTaken: header.dateTaken,
    latitude: header.latitude,
    longitude: header.longitude,
    mtime: stats.mtime.toISOString(),
    fileSize: stats.size,
  };
}

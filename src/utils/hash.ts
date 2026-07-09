import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileMetadata } from '../services/processing/metadata';

// SHA-1 of header/metadata fields only (never pixel data). See DESIGN §9.2.
// mtime is included so an in-place edit is detected as MODIFIED.
export function computeFileHash(filePath: string, metadata: FileMetadata): string {
  const ext = path.extname(filePath).toLowerCase();

  const input = [
    ext,
    metadata.width,
    metadata.height,
    metadata.mtime,
    metadata.colorSpace,
    metadata.fileSize,
    metadata.orientation,
  ].join('|');

  return createHash('sha1').update(input).digest('hex');
}

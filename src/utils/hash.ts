import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileMetadata } from '../services/processing/analysis/metadata';

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

/**
 * SHA-256 of a file's bytes, streamed: the `content_hash` of docs/replication.md §7.1.
 *
 * Here rather than beside the transfers that mostly use it because the one deletion of an original
 * this app makes proves its own case with it (`deletions.ts`), and that module answers to nothing
 * in `services/`.
 */
export async function contentHash(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = Bun.file(filePath).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest('hex');
}

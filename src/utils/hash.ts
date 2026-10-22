import { createHash } from 'node:crypto';
import path from 'node:path';

/** SHA-1 of what a `stat` says about a file, never its bytes (DESIGN §9.2). */
export function computeFileHash(
  filePath: string,
  stat: { mtime: string; fileSize: number },
): string {
  const ext = path.extname(filePath).toLowerCase();
  return createHash('sha1').update([ext, stat.mtime, stat.fileSize].join('|')).digest('hex');
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

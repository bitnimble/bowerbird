import { createHash } from 'node:crypto';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';

const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

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

/**
 * Copies `source` to a new file, keeping its mtime and flushing it to disk, and returns the
 * SHA-256 of the bytes as they left the source, so a caller reads the source once.
 */
export async function copyHashing(source: string, target: string): Promise<string> {
  const input = await open(source, 'r');
  try {
    const { mtime, size } = await input.stat();
    const output = await open(target, 'wx');
    try {
      const hasher = new Bun.CryptoHasher('sha256');
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let copied = 0;
      for (;;) {
        const { bytesRead } = await input.read(chunk, 0, COPY_CHUNK_BYTES);
        if (bytesRead === 0) break;
        const bytes = chunk.subarray(0, bytesRead);
        hasher.update(bytes);
        await writeAll(output, bytes);
        copied += bytesRead;
      }
      // A failing card can end a read early, and the hash and a read-back would both agree.
      if (copied !== size) {
        throw new AppError('IO_ERROR', `read ${copied} of ${size} bytes of ${source}`);
      }
      // The catalogue's file hash is over mtime and size: rescanning a card relies on this to
      // recognise what is already in the library.
      await output.utimes(mtime, mtime);
      await output.sync();
      return hasher.digest('hex');
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

async function writeAll(output: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let written = 0; written < bytes.length;) {
    written += (await output.write(bytes, written)).bytesWritten;
  }
}

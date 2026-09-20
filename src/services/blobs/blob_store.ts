import { readdirSync, statSync } from 'node:fs';
import { link, open } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { unlinkMovedFile } from '../../utils/deletions';
import { ensureDir } from '../../utils/files';
import { containsPath, libraryPath } from '../../utils/paths';

// The disk half of moving originals between peers (docs/replication.md §7.3,
// §7.7): staging, hashing, and the rename into the tree.

// Hidden, so the scan never walks it, and under the library root rather than the
// data directory so the final rename never crosses a filesystem - staged-plus-
// rename is only atomic on one (§8.1).
export function stagingDir(library: Pick<Library, 'root_path'>): string {
  return path.join(library.root_path, '.bowerbird-staging');
}

export function stagePath(library: Pick<Library, 'root_path'>, photoId: string): string {
  return path.join(stagingDir(library), `${photoId}.partial`);
}

export function stagedSize(stageFile: string): number {
  return statSync(stageFile, { throwIfNoEntry: false })?.size ?? 0;
}

/** SHA-256 of the file's bytes, streamed: the `content_hash` of §7.1. */
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
 * Appends a body to a staged blob, returning the staged size afterwards.
 *
 * `offset` must be exactly what is already staged: an append anywhere else
 * would hash-fail at commit only after the whole transfer was paid for.
 */
export async function appendToStage(
  stageFile: string,
  offset: number,
  body: ReadableStream<Uint8Array>,
  onChunk?: (bytes: number) => void,
): Promise<number> {
  await ensureDir(path.dirname(stageFile));
  const staged = stagedSize(stageFile);
  if (staged !== offset) {
    throw new AppError('CONFLICT', `${path.basename(stageFile)} holds ${staged} staged bytes, not ${offset}`);
  }
  const handle = await open(stageFile, 'a');
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      onChunk?.(value.byteLength);
    }
  } finally {
    await handle.close();
  }
  return stagedSize(stageFile);
}

// macOS folds case and hands back NFD where the server minted NFC, so occupancy
// is decided on folded, normalised names: byte-compared, every materialised path
// would scan back as "moved" and churn re-stamps forever (§7.7).
function folded(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The directory entry occupying `name`'s spot, or null when the spot is free. */
export function occupant(dir: string, name: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const want = folded(name);
  return entries.find((entry) => folded(entry) === want) ?? null;
}

export type Placement = { placed: true } | { placed: false; occupiedBy: string };

/**
 * Renames a staged blob to the row's path. Never overwrites and never suffixes:
 * `moveIntoDir`'s suffix loop is for imports, and a suffixed materialisation
 * would diverge from the replicated path and then replicate the accident (§7.7).
 * Occupied - by anything, tracked or not - means skip, and the caller flags it.
 */
export async function materialise(library: Library, filePath: string, stageFile: string): Promise<Placement> {
  const target = libraryPath(library, filePath);
  // A replicated path is remote input to a disk write (§11.2).
  if (!containsPath(library.root_path, target)) {
    throw new AppError('VALIDATION_ERROR', `file path escapes the library root: ${filePath}`);
  }
  // And so is where it is moved *from*. The drain reaches here with a path this peer recorded
  // for the photograph at an earlier merge, which is remote input one step removed - and what
  // follows is a link and then an **unlink of the source**, so a source outside the root is a
  // file taken from somewhere nobody asked about. Staging is under the root (`stagingDir`), so
  // the one legitimate caller passes this too.
  if (!containsPath(library.root_path, stageFile)) {
    throw new AppError('VALIDATION_ERROR', `refusing to take ${stageFile}: it is outside the library`);
  }
  await ensureDir(path.dirname(target));
  const taken = occupant(path.dirname(target), path.basename(target));
  if (taken != null) return { placed: false, occupiedBy: taken };
  try {
    // Claiming the name IS the move, as in moveIntoDir: link cannot overwrite.
    await link(stageFile, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { placed: false, occupiedBy: path.basename(target) };
    }
    throw new AppError('IO_ERROR', `failed to materialise ${filePath}: ${(err as Error).message}`);
  }
  await unlinkMovedFile(stageFile, target);
  return { placed: true };
}

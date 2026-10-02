import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import { deleteEmptyClaim, unlinkMovedFile } from './deletions';

// Atomically moves `from` into `dir` with a collision-free name, returning the
// absolute destination. Claiming the name (moveWithoutReplacing, or COPYFILE_EXCL
// across devices) IS the move, so two concurrent moves of the same basename can't
// overwrite each other the way existsSync()+rename() could.
export async function moveIntoDir(from: string, dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let acrossDevices = false;
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? filename : `${base}_${n}${ext}`);
    try {
      if (!acrossDevices) {
        await moveWithoutReplacing(from, candidate);
        return candidate;
      }
      await copyFile(from, candidate, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue; // name taken (possibly by a concurrent move)
      // A link can't span devices (a custom data dir): retry this same candidate
      // with a (non-atomic) copy, which COPYFILE_EXCL still makes collision-safe.
      if (code === 'EXDEV' && !acrossDevices) {
        acrossDevices = true;
        n--;
        continue;
      }
      throw new AppError(
        'IO_ERROR',
        `failed to move ${from} into ${dir}: ${(err as Error).message}`,
      );
    }
    await unlinkMovedFile(from, candidate);
    return candidate;
  }
}

/**
 * Moves `from` to `to` on the same filesystem, failing with `EEXIST` rather than replacing a file
 * already there, including one another move is placing at the same moment.
 */
export async function moveWithoutReplacing(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Android refuses an app's hard links outright (SELinux), whatever the directory allows.
    if (code !== 'EPERM' && code !== 'EACCES') throw err;
    await moveOverClaim(from, to);
    return;
  }
  await unlinkMovedFile(from, to);
}

/** The same, claiming `to` with an exclusive create and renaming the bytes over that claim. */
export async function moveOverClaim(from: string, to: string): Promise<void> {
  await (await open(to, 'wx')).close();
  try {
    await rename(from, to);
  } catch (err) {
    await deleteEmptyClaim(to).catch(() => undefined);
    throw err;
  }
}

const REPLACE_RETRY_MS = 1000;

/**
 * Renames `from` over `to`. Windows refuses to replace a file another handle has open, such as
 * a rendition being served or a second fetch landing, so there a refusal is retried for a second.
 */
export async function replaceFile(from: string, to: string): Promise<void> {
  const deadline = performance.now() + REPLACE_RETRY_MS;
  for (let wait = 10; ; wait = Math.min(wait * 2, 100)) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy =
        process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY');
      if (!busy || performance.now() >= deadline) throw err;
      await Bun.sleep(wait);
    }
  }
}

export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new AppError('IO_ERROR', `failed to create directory ${dir}: ${(err as Error).message}`);
  }
}

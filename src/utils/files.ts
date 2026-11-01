import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import { newId } from '../schemas/id';
import { deleteEmptyClaim, unlinkMovedFile } from './deletions';

// Atomically moves `from` into `dir` with a collision-free name, returning the
// absolute destination. Claiming the name (moveWithoutReplacing, or COPYFILE_EXCL
// across devices) IS the move, so two concurrent moves of the same basename can't
// overwrite each other the way existsSync()+rename() could.
export async function moveIntoDir(from: string, dir: string, filename: string): Promise<string> {
  let acrossDevices = false;
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, numberedName(filename, n));
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

/** `filename` as is for 0, then `name_1.ext`, `name_2.ext` and on. */
export function numberedName(filename: string, n: number): string {
  if (n === 0) return filename;
  const ext = path.extname(filename);
  return `${path.basename(filename, ext)}_${n}${ext}`;
}

// Android refuses an app's hard links outright (SELinux), and exFAT and SMB have none to make. On
// Windows exFAT, libuv reports ERROR_INVALID_FUNCTION as EISDIR.
const NO_HARD_LINKS = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EISDIR']);

/**
 * Moves `from` to `to` on the same filesystem, failing with `EEXIST` rather than replacing a file
 * already there, including one another move is placing at the same moment.
 */
export async function moveWithoutReplacing(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code == null || !NO_HARD_LINKS.has(code)) throw err;
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

export const STAGING_SUFFIX = '.tmp';

/** Where to stage `final` for `replaceFile`; the prune sweep spares it while young. */
export function stagingPathFor(final: string): string {
  return `${final}.${newId()}${STAGING_SUFFIX}`;
}

export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new AppError('IO_ERROR', `failed to create directory ${dir}: ${(err as Error).message}`);
  }
}

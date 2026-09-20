import { constants as fsConstants } from 'node:fs';
import { copyFile, link, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import { unlinkMovedFile } from './deletions';

// Atomically moves `from` into `dir` with a collision-free name, returning the
// absolute destination. Claiming the name (link, or COPYFILE_EXCL across
// devices) IS the move, so two concurrent moves of the same basename can't
// overwrite each other the way existsSync()+rename() could.
export async function moveIntoDir(from: string, dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let claim = (to: string): Promise<void> => link(from, to);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? filename : `${base}_${n}${ext}`);
    try {
      await claim(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue; // name taken (possibly by a concurrent move)
      // link() can't span devices (a custom data dir): retry this same candidate
      // with a (non-atomic) copy, which COPYFILE_EXCL still makes collision-safe.
      if (code === 'EXDEV') {
        claim = (to) => copyFile(from, to, fsConstants.COPYFILE_EXCL);
        n--;
        continue;
      }
      throw new AppError('IO_ERROR', `failed to move ${from} into ${dir}: ${(err as Error).message}`);
    }
    await unlinkMovedFile(from, candidate);
    return candidate;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new AppError('IO_ERROR', `failed to create directory ${dir}: ${(err as Error).message}`);
  }
}

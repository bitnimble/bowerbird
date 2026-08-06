import { statSync } from 'node:fs';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { ensureDir } from '../../utils/files';
import { getBinPath } from '../../utils/paths';
import type { LibrariesRepository } from './libraries_repository';

/**
 * The library's bin folder, made and its identity recorded if it was not there.
 * Throws for a library with no bin (§2.5), whose callers all have a branch of
 * their own for that case.
 *
 * The single owner of creating it, because the alternative is `ensureDir`
 * silently recreating a hand-deleted bin with a **new inode** while the columns
 * still name the dead one - after which §6.3 can never follow a rename, and that
 * freed inode number is the likeliest to be recycled into §6.3's false-positive
 * case.
 */
export async function ensureBinFolder(library: Library, libraries: LibrariesRepository): Promise<string> {
  const bin = getBinPath(library);
  if (bin == null) throw new AppError('READ_ONLY', `library ${library.id} has no bin folder`);
  const before = statSync(bin, { throwIfNoEntry: false });
  if (before != null) return bin;

  await ensureDir(bin);
  const made = statSync(bin, { throwIfNoEntry: false });
  libraries.setBinIdentity(library.id, {
    dev: made?.dev ?? null,
    ino: made?.ino ?? null,
    birthtime: made?.birthtimeMs ?? null,
  });
  return bin;
}

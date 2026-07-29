import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import type { BrowseResponse } from '../schemas/browse';
import { containsPath, toLibraryRelative } from './paths';

// Walking directories for the pickers that choose where photographs live: a
// library root anywhere on the server, and a shoot's folder inside one library.
// Directories only, because both questions are about the shape of the tree and
// listing the files would be handing over the catalogue's contents to answer it.

/** Anywhere on the server, in absolute paths. */
export async function browseAbsolute(dir: string): Promise<BrowseResponse> {
  const names = await directoryNames(dir);
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    directories: names.map((name) => ({ name, path: path.join(dir, name) })),
  };
}

// Inside one library, in the root-relative paths a shoot's `folder_path` is
// stored as ('' is the root itself). The root is a fence as well as an origin: a
// shoot's folder has to be inside its library, so a `..` that would climb out is
// refused here rather than caught later by whatever it was on its way to.
export async function browseUnder(root: string, relative: string): Promise<BrowseResponse> {
  const dir = path.resolve(root, relative);
  if (!containsPath(root, dir)) throw new AppError('VALIDATION_ERROR', `path is outside the library: ${relative}`);

  const names = await directoryNames(dir);
  const here = toLibraryRelative(root, dir);
  return {
    path: here,
    parent: here === '' ? null : toLibraryRelative(root, path.dirname(dir)),
    directories: names.map((name) => ({ name, path: here === '' ? name : `${here}/${name}` })),
  };
}

async function directoryNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('NOT_FOUND', `no such directory: ${dir}`);
    if (code === 'EACCES' || code === 'EPERM') throw new AppError('VALIDATION_ERROR', `cannot read ${dir}: permission denied`);
    throw err;
  }

  const names: string[] = [];
  for (const entry of entries) {
    // Hidden directories are configuration and caches rather than photographs,
    // and they are most of what a home directory holds. It also keeps a
    // library's own `.bowerbird` out of the shoot picker, where choosing it
    // would put photographs inside the disposable tree (§6).
    if (entry.name.startsWith('.')) continue;
    if (!(await isDirectory(dir, entry))) continue;
    names.push(entry.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

// A symlinked directory is still somewhere photographs can live, and a mount
// pointed at by one is a common way to reach an external drive, so the target is
// what decides. A broken or unreadable link is simply not offered.
async function isDirectory(dir: string, entry: { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(dir, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

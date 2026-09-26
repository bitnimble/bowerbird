import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';
import type { BrowseResponse } from '../schemas/browse';
import { isDirInScope, type LibraryScope } from './scope';

// Walking directories for the pickers that choose where photographs live: a
// library root anywhere on the server, and a shoot's folder inside one library.
// Directories only, because both questions are about the shape of the tree and
// listing the files would be handing over the catalogue's contents to answer it.

/** Anywhere on the server, in absolute paths. */
export async function browseAbsolute(dir: string, writable?: (dir: string) => boolean): Promise<BrowseResponse> {
  const names = await directoryNames(dir);
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    directories: names.map((name) => ({ name, path: path.join(dir, name) })),
    writable: writable?.(dir),
  };
}

export async function createFolder(dir: string): Promise<void> {
  try {
    await mkdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new AppError('CONFLICT', `${dir} already exists`);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('NOT_FOUND', `no such directory: ${path.dirname(dir)}`);
    if (code === 'EACCES' || code === 'EPERM') throw new AppError('VALIDATION_ERROR', `cannot create ${dir}: permission denied`);
    throw err;
  }
}

// Every folder the library contains, in the root-relative paths a shoot's
// `folder_path` is stored as, depth-first so a parent precedes its children.
// Whatever the scan would skip is skipped here too, and skipped whole: an
// excluded folder's children are not the library's either.
export async function foldersUnder(scope: LibraryScope): Promise<string[]> {
  const found: string[] = [];
  const visited = new Set<string>(); // real paths, to stop symlink cycles

  async function walk(absDir: string, relDir: string): Promise<void> {
    const real = await realpath(absDir).catch(() => absDir);
    if (visited.has(real)) return;
    visited.add(real);
    // A folder that has become unreadable since it was listed costs its own
    // subtree, not the whole answer; the root is the one that is worth a failure.
    const names = relDir === '' ? await directoryNames(absDir) : await directoryNames(absDir).catch(() => []);
    for (const name of names) {
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (!isDirInScope(scope, rel)) continue;
      found.push(rel);
      await walk(path.join(absDir, name), rel);
    }
  }

  await walk(scope.rootPath, '');
  return found;
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
    // and they are most of what a home directory holds.
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

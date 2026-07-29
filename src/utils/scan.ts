import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDirInScope, type LibraryScope } from './scope';

// The scan filter, and the media type each format is served under. See DESIGN §7:
// the decoder is chosen later by header sniff, so a format is added here and read
// by whichever reader already handles it.
const RAW_MEDIA_TYPES = new Map([
  ['.arw', 'image/x-sony-arw'],
  ['.cr2', 'image/x-canon-cr2'],
  ['.cr3', 'image/x-canon-cr3'],
]);

export function isSupportedFile(filename: string): boolean {
  return RAW_MEDIA_TYPES.has(path.extname(filename).toLowerCase());
}

// What an original is served as. Falls back to a generic binary rather than
// guessing, for a row whose path predates a format being dropped from the set.
export function rawMediaType(filename: string): string {
  return RAW_MEDIA_TYPES.get(path.extname(filename).toLowerCase()) ?? 'application/octet-stream';
}

export interface ScannedFile {
  // path relative to the scan root, forward slashes
  relPath: string;
  absPath: string;
}

// A folder the walk descended into, with the identity that survives its being
// renamed (DESIGN §4.3). `birthtimeMs` is 0 on filesystems that report no
// creation time, which is why §9.4.1 treats it as corroboration rather than as
// half of the key.
export interface ScannedDir {
  relPath: string;
  ino: number;
  birthtimeMs: number;
}

export interface TreeScan {
  files: ScannedFile[];
  dirs: ScannedDir[];
}

// Walk everything the library contains, per `isInScope` (§9.1). Directories are
// `stat`ed as they are entered: one call each, against the per-file stats the
// scan already does, for the folder identities relocation reads.
export async function scanLibraryTree(scope: LibraryScope): Promise<TreeScan> {
  const files: ScannedFile[] = [];
  const dirs: ScannedDir[] = [];
  const visitedDirs = new Set<string>(); // real paths, to stop symlink cycles

  const relative = (abs: string): string => path.relative(scope.rootPath, abs).split(path.sep).join('/');

  async function walk(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);

      // dirent flags describe the link itself; follow symlinks to classify them.
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(abs);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // broken symlink
        }
      }

      const rel = relative(abs);
      if (isDir) {
        if (!isDirInScope(scope, rel)) continue;
        const real = await realpath(abs).catch(() => abs);
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        const stats = await stat(abs).catch(() => null);
        if (stats != null) dirs.push({ relPath: rel, ino: stats.ino, birthtimeMs: stats.birthtimeMs });
        await walk(abs);
      } else if (isFile && isSupportedFile(entry.name)) {
        files.push({ relPath: rel, absPath: abs });
      }
    }
  }

  visitedDirs.add(await realpath(scope.rootPath).catch(() => path.resolve(scope.rootPath))); // so a symlink back to root can't re-walk the tree
  await walk(scope.rootPath);
  return { files, dirs };
}

// Every supported file anywhere under `dir`, excluded directories included: used
// to prove a tree holds no originals before it is removed wholesale, where the
// scanner's skip list would be exactly the wrong thing to honour.
export async function findOriginalsAnywhere(dir: string): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  async function walk(absDir: string): Promise<void> {
    const real = await realpath(absDir).catch(() => path.resolve(absDir));
    if (seen.has(real)) return;
    seen.add(real);
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      // Symlinks are followed for classification but never counted as originals:
      // a link into the user's photographs is not a file this tree owns, and
      // removing the tree only removes the link.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && isSupportedFile(entry.name)) found.push(abs);
    }
  }

  await walk(dir);
  return found;
}

import { existsSync } from 'node:fs';
import { copyFile, link, readdir, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.arw']);

export function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

// Directory basenames the scanner never descends into. See DESIGN §6, §12.2.
//  - hidden dirs (leading '.') covers `.bowerbird` and other dotfolders
//  - `Bin` covers the per-shoot deletion bins so soft-deleted files aren't re-imported
function isExcludedDir(name: string): boolean {
  return name.startsWith('.') || name === 'Bin';
}

export interface ScannedFile {
  // path relative to the scan root, forward slashes
  relPath: string;
  absPath: string;
}

// Recursively list supported files under `rootPath`, skipping excluded dirs and
// anything under `dataPath` when it lives inside the root.
export async function listSupportedFiles(rootPath: string, dataPath: string): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];
  const resolvedData = path.resolve(dataPath);
  const visitedDirs = new Set<string>(); // real paths, to stop symlink cycles

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

      if (isDir) {
        if (isExcludedDir(entry.name)) continue;
        if (path.resolve(abs) === resolvedData) continue;
        const real = await realpath(abs).catch(() => abs);
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        await walk(abs);
      } else if (isFile && isSupportedFile(entry.name)) {
        const rel = path.relative(rootPath, abs).split(path.sep).join('/');
        results.push({ relPath: rel, absPath: abs });
      }
    }
  }

  visitedDirs.add(await realpath(rootPath).catch(() => path.resolve(rootPath))); // so a symlink back to root can't re-walk the tree
  await walk(rootPath);
  return results;
}

// Non-colliding destination in `dir` for `filename`, appending _1, _2, ... before
// the extension if needed (DESIGN §12.1). Returns an absolute path.
export function uniqueDestPath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  for (let n = 1; existsSync(candidate); n++) {
    candidate = path.join(dir, `${base}_${n}${ext}`);
  }
  return candidate;
}

// Atomically moves `from` into `dir` with a collision-free name, returning the
// absolute destination. link()+unlink() makes name selection and the move a
// single step, so two concurrent moves of the same basename can't overwrite each
// other the way existsSync()+rename() could. Falls back to a (non-atomic) copy
// when the destination is on a different filesystem (a custom data dir).
export async function moveIntoDir(from: string, dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? filename : `${base}_${n}${ext}`);
    try {
      await link(from, candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue; // name taken (possibly by a concurrent move)
      if (code === 'EXDEV') {
        const dest = uniqueDestPath(dir, filename);
        await copyFile(from, dest);
        await unlink(from);
        return dest;
      }
      throw err;
    }
    await unlink(from);
    return candidate;
  }
}

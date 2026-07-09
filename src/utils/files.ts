import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
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

  await walk(rootPath);
  return results;
}

export async function fileMtimeIso(absPath: string): Promise<string> {
  const s = await stat(absPath);
  return s.mtime.toISOString();
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

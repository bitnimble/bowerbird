import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.arw']);

export function isSupportedFile(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

// Directory basenames the scanner never descends into. See DESIGN §6, §12.2.
//  - hidden dirs (leading '.') covers `.bowerbird` and other dotfolders
//  - `Bin` covers the deletion bins so soft-deleted files aren't re-imported
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

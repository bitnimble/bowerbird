import { readdir, stat } from 'node:fs/promises';
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

  async function walk(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        if (path.resolve(abs) === resolvedData) continue;
        await walk(abs);
      } else if (entry.isFile() && isSupportedFile(entry.name)) {
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

import { constants as fsConstants } from 'node:fs';
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

export interface PrunedScan {
  // Files in directories whose mtime is unchanged since the last scan: their set
  // can't have changed (add/remove/rename bumps dir mtime), so they're present and
  // need no re-stat. Caveat: an in-place content edit doesn't bump dir mtime, so
  // it is NOT detected here (see config.syncPruneUnchangedDirs).
  unchangedFiles: ScannedFile[];
  // Files in new or structurally-changed directories: still need a stat/quick-check.
  changedFiles: ScannedFile[];
  // relDir -> mtimeMs for every walked directory, to feed the next scan.
  dirMtimes: Map<string, number>;
}

// Like listSupportedFiles, but splits files by whether their directory's mtime
// changed since `priorMtimes`, so an unchanged directory's files can skip the
// per-file stat. Still descends every directory (a subdir's contents may change
// without bumping its parent's mtime).
export async function listSupportedFilesPruned(
  rootPath: string,
  dataPath: string,
  priorMtimes: ReadonlyMap<string, number>,
): Promise<PrunedScan> {
  const unchangedFiles: ScannedFile[] = [];
  const changedFiles: ScannedFile[] = [];
  const dirMtimes = new Map<string, number>();
  const resolvedData = path.resolve(dataPath);
  const visitedDirs = new Set<string>();

  async function walk(absDir: string, relDir: string): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(absDir)).mtimeMs;
    } catch {
      return; // directory vanished mid-walk
    }
    dirMtimes.set(relDir, mtimeMs);
    const dirUnchanged = priorMtimes.get(relDir) === mtimeMs;
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await stat(abs);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (isExcludedDir(entry.name)) continue;
        if (path.resolve(abs) === resolvedData) continue;
        const real = await realpath(abs).catch(() => abs);
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        await walk(abs, relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (isFile && isSupportedFile(entry.name)) {
        const rel = path.relative(rootPath, abs).split(path.sep).join('/');
        (dirUnchanged ? unchangedFiles : changedFiles).push({ relPath: rel, absPath: abs });
      }
    }
  }

  visitedDirs.add(await realpath(rootPath).catch(() => path.resolve(rootPath)));
  await walk(rootPath, '');
  return { unchangedFiles, changedFiles, dirMtimes };
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
      if (code === 'EXDEV') return moveCrossDevice(from, dir, filename);
      throw err;
    }
    await unlink(from);
    return candidate;
  }
}

// Cross-filesystem move (link() can't span devices). COPYFILE_EXCL claims each
// candidate name atomically, it fails EEXIST rather than clobbering, so two
// concurrent moves of the same basename can't overwrite each other the way
// existsSync()+copyFile() could.
async function moveCrossDevice(from: string, dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n === 0 ? filename : `${base}_${n}${ext}`);
    try {
      await copyFile(from, candidate, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    await unlink(from);
    return candidate;
  }
}

import { readdir, realpath, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { RENDITION_EXTENSION } from '../services/processing/renditions/renditions';
import { isDirInScope, type LibraryScope } from './scope';

// The scan filter, and the media type each format is served under. See DESIGN §7:
// the decoder is chosen later by header sniff, so a format is added here and read
// by whichever reader already handles it.
const RAW_MEDIA_TYPES = new Map([
  ['.arw', 'image/x-sony-arw'],
  ['.cr2', 'image/x-canon-cr2'],
  ['.cr3', 'image/x-canon-cr3'],
  ['.raf', 'image/x-fuji-raf'],
  ['.dng', 'image/x-adobe-dng'],
]);

// The formats that arrive already rendered: no mosaic, so no denoise, no dust and
// no demosaic, and everything below those runs on them unchanged. Imported only
// where the library asked for them (`include_non_raw`).
const RENDERED_MEDIA_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  // What Canon and Fujifilm write their HEIF stills as.
  ['.hif', 'image/heif'],
  ['.avif', 'image/avif'],
]);

function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

/**
 * What the catalogue records a photograph's format as, for the column of the same name (§4.2).
 *
 * **The spellings collapse and the formats do not.** `.jpg` and `.jpeg` are one format written two
 * ways, and so are `.heic`, `.heif` and `.hif` - a reader filtering for HEIC means all three, and a
 * column holding whichever the camera happened to write makes that filter a list of extensions to
 * remember. CR2 and CR3 stay apart, because they are different formats that Canon happens to have
 * numbered.
 *
 * Null where the extension is not one this application imports, which a stored row cannot be
 * unless it predates the format being dropped from the set.
 */
export function formatOf(filename: string): PhotoFormat | null {
  const extension = extensionOf(filename);
  return FORMATS.get(extension) ?? null;
}

export type PhotoFormat = 'arw' | 'cr2' | 'cr3' | 'raf' | 'dng' | 'jpeg' | 'png' | 'heif' | 'avif';

const FORMATS = new Map<string, PhotoFormat>([
  ['.arw', 'arw'],
  ['.cr2', 'cr2'],
  ['.cr3', 'cr3'],
  ['.raf', 'raf'],
  ['.dng', 'dng'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.png', 'png'],
  ['.heic', 'heif'],
  ['.heif', 'heif'],
  ['.hif', 'heif'],
  ['.avif', 'avif'],
]);

/** A file this application can hold as an original, whatever a library imports. */
export function isOriginal(filename: string): boolean {
  const extension = extensionOf(filename);
  return RAW_MEDIA_TYPES.has(extension) || RENDERED_MEDIA_TYPES.has(extension);
}

/**
 * Whether `scope`'s library imports a file of this name.
 *
 * The RAWs always; the rendered formats only where the library asked for them,
 * because beside a folder of RAWs they are usually the camera's own copies of
 * frames the library already holds.
 */
export function importsFormat(scope: LibraryScope, filename: string): boolean {
  const extension = extensionOf(filename);
  return RAW_MEDIA_TYPES.has(extension) || (scope.includeNonRaw && RENDERED_MEDIA_TYPES.has(extension));
}

/**
 * Whether a photograph of this name can be shown from a JPEG that costs no build.
 *
 * **A RAW's is the camera's own rendering, lifted out of it; a JPEG's is the file.** A PNG, a
 * HEIC or an AVIF has neither, so the `embedded` rendition is not something the viewer may fall
 * back to for one - it would ask for a file that cannot exist and stall on the 404 that normally
 * heals a missing render.
 */
// Null is a row with no single file behind it - a composite - which has no camera JPEG for the
// same reason it has no camera: nothing wrote it but this application.
export function hasEmbeddedJpeg(filename: string | null): boolean {
  if (filename == null) return false;
  return RAW_MEDIA_TYPES.has(extensionOf(filename)) || isEmbeddedJpegItself(filename);
}

/**
 * Whether the photograph's own file *is* the JPEG, rather than carrying one inside it.
 *
 * The difference is a stat against a decode: a RAW's preview has to be lifted out to be
 * measured, and this one's weight is the file's. Here rather than at the caller because the
 * extension set is this module's, and it was already spelled in three shapes above.
 */
export function isEmbeddedJpegItself(filename: string): boolean {
  const extension = extensionOf(filename);
  return extension === '.jpg' || extension === '.jpeg';
}

/**
 * Whether a file found under a data directory is somebody's original.
 *
 * **Not [`isOriginal`], and the difference is load-bearing.** Every rendition
 * this application writes is AVIF, so an `.avif` under `DATA_DIR` is one of ours
 * by construction. Reading one as an original would refuse to sweep a single
 * rendition and refuse to remove any library's data directory.
 */
export function isStrayOriginal(filename: string): boolean {
  return isOriginal(filename) && extensionOf(filename) !== RENDITION_EXTENSION;
}

// What an original is served as. Falls back to a generic binary rather than
// guessing, for a row whose path predates a format being dropped from the set.
export function originalMediaType(filename: string): string {
  const extension = extensionOf(filename);
  return (
    RAW_MEDIA_TYPES.get(extension) ?? RENDERED_MEDIA_TYPES.get(extension) ?? 'application/octet-stream'
  );
}

export interface ScannedFile {
  // path relative to the scan root, forward slashes
  relPath: string;
  absPath: string;
}

// A folder the walk descended into, with the identity that survives its being
// renamed (DESIGN §4.3). `dev` belongs with `ino` because inode numbers are
// unique only within one filesystem. `birthtimeMs` is 0 on filesystems that
// report no creation time, which is why §9.4.1 treats it as corroboration rather
// than as part of the key.
export interface ScannedDir {
  relPath: string;
  dev: number;
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
//
// `startDir` is root-relative and defaults to the whole library. The bin channel
// walks its own subtree through it (§9.1.1), which is what keeps every relPath
// library-root relative on both channels.
//
// `onDir` is called as each directory is entered: the walk is one of the four
// stretches long enough for a sync lease to lapse inside it (§9.7).
//
// `descend` overrides which directories the walk enters. The bin channel passes
// one, because inside the bin none of the library's rules apply: the bin mirrors
// folders even in a root-only library, an excluded folder's binned frames are
// still the bin's, and a bin the photographer named with a leading dot is not a
// dotfolder to skip - it is the tree being walked (§9.1.1).
export async function scanLibraryTree(
  scope: LibraryScope,
  startDir = '',
  onDir?: () => void,
  descend: (relDir: string) => boolean = (relDir) => isDirInScope(scope, relDir),
): Promise<TreeScan> {
  const files: ScannedFile[] = [];
  const dirs: ScannedDir[] = [];
  const visitedDirs = new Set<string>(); // real paths, to stop symlink cycles

  const relative = (abs: string): string => path.relative(scope.rootPath, abs).split(path.sep).join('/');

  async function walk(absDir: string): Promise<void> {
    onDir?.();
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
        if (!descend(rel)) continue;
        const real = await realpath(abs).catch(() => abs);
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        // Sync rather than awaited: the `realpath` above already warmed this
        // inode, so there is no I/O left to wait on and the promise machinery is
        // the whole cost - 22us a call against 2us, which is 400ms of a 20k-folder
        // walk spent on nothing.
        const stats = statSync(abs, { throwIfNoEntry: false });
        if (stats != null) dirs.push({ relPath: rel, dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs });
        await walk(abs);
      } else if (isFile && importsFormat(scope, entry.name)) {
        files.push({ relPath: rel, absPath: abs });
      }
    }
  }

  const absStart = startDir === '' ? scope.rootPath : path.join(scope.rootPath, startDir);
  visitedDirs.add(await realpath(absStart).catch(() => path.resolve(absStart))); // so a symlink back to the start can't re-walk the tree
  await walk(absStart);
  return { files, dirs };
}

// Every original anywhere under `dir`, excluded directories included: used to
// prove a tree holds none before it is removed wholesale, where the scanner's
// skip list would be exactly the wrong thing to honour. Only ever asked of a data
// directory, which is what lets it read an `.avif` as a rendition of ours
// ([`isStrayOriginal`]).
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
      else if (entry.isFile() && isStrayOriginal(entry.name)) found.push(abs);
    }
  }

  await walk(dir);
  return found;
}

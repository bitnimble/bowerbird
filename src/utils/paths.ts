import path from 'node:path';
import { config } from '../config';
import type { Library } from '../schemas/libraries';
import { RENDITION_EXTENSION, renditionDir, type Rendition } from '../services/processing/renditions';

// Whether `child` is `parent` or sits beneath it. Resolved first, so a relative
// path or a `..` cannot slip past by spelling.
export function containsPath(parent: string, child: string): boolean {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

// Id-level variant, for callers holding a joined row rather than a Library.
export function dataPathForLibraryId(libraryId: string): string {
  return path.join(config.dataDir, libraryId);
}

export function getDataPath(library: Pick<Library, 'id'>): string {
  return dataPathForLibraryId(library.id);
}

// Every rendition is AVIF (§10.2). It decodes natively in every current browser,
// is the only format here that carries HDR, and beats WebP on size at matched
// quality. Files written under the old extensions are swept by the orphan pass,
// which keys on the extension a directory is supposed to hold (§10.6).
//
// One directory per rendition *and* per dynamic range, so every generated file
// stays `<photoId>.<ext>` and the orphan sweep can keep reading a filename as an
// id. Range is in the directory rather than the filename because the file is the
// cache: a rendition built before HDR was turned on would otherwise be served
// forever under the same name.
export function renditionPathFor(dataPath: string, photoId: string, rendition: Rendition, hdr: boolean): string {
  return path.join(dataPath, 'renditions', renditionDir(rendition, hdr), `${photoId}${RENDITION_EXTENSION}`);
}

export function getRenditionPath(library: Library, photoId: string, rendition: Rendition, hdr: boolean): string {
  return renditionPathFor(getDataPath(library), photoId, rendition, hdr);
}

/**
 * Where this photo's camera match is kept (`native/rawshim/src/camera_match.rs`).
 *
 * **Beside `renditions/` rather than inside it, and that is the whole point of the directory.**
 * A rendition is a cache: it can be deleted at any moment and the next request rebuilds it, and
 * the orphan sweep is free to take any file in there that no photo claims. A match is not that.
 * It costs half a second of fitting, it depends on nothing but the RAW, and losing one is
 * paying that again for every render, rebuild, editor open and loupe tile of that photograph.
 * So it lives one level up, where wiping the cache does not reach it.
 *
 * `<photoId>.bbm`, so a filename still reads as an id if anything ever has to sweep these too.
 */
export function cameraMatchPathFor(dataPath: string, photoId: string): string {
  return path.join(dataPath, 'matches', `${photoId}.bbm`);
}

// The Bin holds originals, which is why it lives beside the photographs and not
// in the data directory: everything under `DATA_DIR` is generated and must stay
// disposable, so that removing a library (or the user clearing that directory by
// hand) can never cost a RAW.
//
// One bin per library, at its root, mirroring inside itself the folder a photo
// was binned from: `A/B/c.arw` bins to `<bin>/A/B/c.arw` (§12.3). `relFolder` is
// that folder, and empty for a photo binned from the root.
//
// Null when the library has no bin, which is what a library born read-only is:
// nothing on disk can record a binning, so `is_deleted` is the only truth (§4.1).
//
// The only place the bin's folder name is spelled: it is per library (§12.3) and
// the scan skips it by name, so a second spelling anywhere is a bin the scan
// walks straight back into. That is also what makes renaming it tractable (§4.1).
export function getBinPath(library: Pick<Library, 'root_path' | 'bin_name'>, relFolder = ''): string | null {
  return library.bin_name == null ? null : path.join(library.root_path, library.bin_name, relFolder);
}

// Rolling catalogue snapshots (§4.9), beside the database rather than under
// `DATA_DIR` where everything else this app generates lives: that directory is
// disposable by design (§6), removed whole with its library and safe for a user to
// clear by hand to reclaim space. A backup is the one generated file for which
// that is false.
export function backupsDir(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'backups');
}

// Absolute path to a photo's original RAW, given its root-relative file_path.
export function getOriginalPath(library: Library, filePath: string): string {
  return path.join(library.root_path, filePath);
}

// A file_path value (root-relative, forward slashes) for an absolute path.
export function toLibraryRelative(rootPath: string, absPath: string): string {
  return path.relative(rootPath, absPath).split(path.sep).join('/');
}

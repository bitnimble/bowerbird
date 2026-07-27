import path from 'node:path';
import type { Library } from '../schemas/libraries';
import type { HdrVariant } from '../services/processing/hdr_video';

// Column-level variant, for callers holding a joined row rather than a Library.
export function dataPathFor(rootPath: string, dataPath: string | null): string {
  return dataPath ?? path.join(rootPath, '.bowerbird');
}

export function getDataPath(library: Library): string {
  return dataPathFor(library.root_path, library.data_path);
}

export function getSmallThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'small', `${photoId}.webp`);
}

export function getFullThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'full', `${photoId}.webp`);
}

// Full-resolution export, built only on request (§10.5). Kept beside the
// thumbnails so removing a library's data directory takes it too.
export function getLosslessPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'lossless', `${photoId}.jxl`);
}

// One directory per variant, so every generated file stays `<photoId>.<ext>`
// and the orphan sweep can keep reading a filename as an id (§10.6).
export function getHdrVideoPath(library: Library, photoId: string, variant: HdrVariant): string {
  return path.join(getDataPath(library), 'hdr', variant, `${photoId}.mp4`);
}

export function getBinPath(library: Library): string {
  return path.join(getDataPath(library), 'bin');
}

// Absolute path to a photo's original RAW, given its root-relative file_path.
export function getOriginalPath(library: Library, filePath: string): string {
  return path.join(library.root_path, filePath);
}

// A file_path value (root-relative, forward slashes) for an absolute path.
export function toLibraryRelative(rootPath: string, absPath: string): string {
  return path.relative(rootPath, absPath).split(path.sep).join('/');
}

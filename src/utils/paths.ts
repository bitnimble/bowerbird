import path from 'node:path';
import type { Library } from '../schemas/libraries';

export function getDataPath(library: Library): string {
  return library.data_path ?? path.join(library.root_path, '.bowerbird');
}

export function getSmallThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'small', `${photoId}.webp`);
}

export function getFullThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'full', `${photoId}.webp`);
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

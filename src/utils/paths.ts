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

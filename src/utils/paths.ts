import path from 'node:path';
import type { Library } from '../schemas/libraries';
import { extensionFor, type HdrMedium, type HdrVariant } from '../services/processing/hdr_media';
import type { ThumbnailSource } from '../services/processing/processing_types';

// Column-level variant, for callers holding a joined row rather than a Library.
export function dataPathFor(rootPath: string, dataPath: string | null): string {
  return dataPath ?? path.join(rootPath, '.bowerbird');
}

export function getDataPath(library: Library): string {
  return dataPathFor(library.root_path, library.data_path);
}

// Every rendition is AVIF (§10.2). It decodes natively in every current browser
// with no polyfill, is the only format here that carries HDR to Chrome and
// Safari alike, and beats WebP on size at matched quality. Files written under
// the old extensions are swept by the orphan pass, which keys on the extension a
// directory is supposed to hold (§10.6).
export function getSmallThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'small', `${photoId}.avif`);
}

export function getFullThumbnailPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'thumbnails', 'full', `${photoId}.avif`);
}

// A full-size preview from a source other than the one the photo's own
// thumbnails were built from, so the detail view can switch between renditions
// without rebuilding one every time. One directory per source, so every
// generated file stays `<photoId>.<ext>` for the orphan sweep.
export function getPreviewPath(library: Library, photoId: string, source: ThumbnailSource): string {
  return path.join(getDataPath(library), 'previews', source, `${photoId}.avif`);
}

// The same HDR preview as a one-frame video, built alongside it when a library
// renders HDR. Firefox applies a PQ transfer to nothing else - it shows an HDR
// still dark - so this is the only rendition that reaches an HDR display there
// (§10.7). One per photo, not per source: only a render is ever HDR.
export function getPreviewVideoPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'previews', 'video', `${photoId}.mp4`);
}

// Full-resolution export, built only on request (§10.5). Kept beside the
// thumbnails so removing a library's data directory takes it too.
export function getLosslessPath(library: Library, photoId: string): string {
  return path.join(getDataPath(library), 'lossless', `${photoId}.avif`);
}

// One directory per medium and variant, so every generated file stays
// `<photoId>.<ext>` and the orphan sweep can keep reading a filename as an id
// (§10.6).
export function getHdrPath(library: Library, photoId: string, medium: HdrMedium, variant: HdrVariant): string {
  return path.join(getDataPath(library), 'hdr', medium, variant, `${photoId}${extensionFor(medium)}`);
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

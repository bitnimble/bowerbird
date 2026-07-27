import path from 'node:path';
import type { Library } from '../schemas/libraries';
import { extensionFor, type HdrMedium, type HdrVariant } from '../services/processing/hdr_media';
import { renditionDir, renditionExtension, type Rendition } from '../services/processing/renditions';

// Column-level variant, for callers holding a joined row rather than a Library.
export function dataPathFor(rootPath: string, dataPath: string | null): string {
  return dataPath ?? path.join(rootPath, '.bowerbird');
}

export function getDataPath(library: Library): string {
  return dataPathFor(library.root_path, library.data_path);
}

// Every rendition is AVIF, or MP4 for the HDR video twin (§10.2). AVIF decodes
// natively in every current browser with no polyfill, is the only format here
// that carries HDR to Chrome and Safari alike, and beats WebP on size at matched
// quality. Files written under the old extensions are swept by the orphan pass,
// which keys on the extension a directory is supposed to hold (§10.6).
//
// One directory per rendition *and* per dynamic range, so every generated file
// stays `<photoId>.<ext>` and the orphan sweep can keep reading a filename as an
// id. Range is in the directory rather than the filename because the file is the
// cache: a preview built before HDR was turned on would otherwise be served
// forever under the same name.
export function renditionPathFor(
  dataPath: string,
  photoId: string,
  rendition: Rendition,
  hdr: boolean,
  video = false,
): string {
  const dir = renditionDir(rendition, hdr, video);
  return path.join(dataPath, 'renditions', dir, `${photoId}${renditionExtension(video)}`);
}

export function getRenditionPath(
  library: Library,
  photoId: string,
  rendition: Rendition,
  hdr: boolean,
  video = false,
): string {
  return renditionPathFor(getDataPath(library), photoId, rendition, hdr, video);
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

import { type PhotoSummary } from '../../../../src/schemas/photos';
import { type ViewerRendition } from '../../../../src/schemas/settings';
import { type Rendition } from '../../../../src/services/processing/renditions/renditions';
import { PathSegment, route } from '../../../../src/schemas/route';

/** How many colours open stacks are told apart by before they repeat (`bandColour` in `photo_grid.tsx`). */
export const BAND_COLOURS = 3;

// Which collection the grid is showing. One store serves the library, shoot,
// album, bin and missing views because they differ only in the fetch call.
export type PhotoSource =
  | { kind: 'library'; libraryId: string }
  | { kind: 'shoot'; shootId: string }
  | { kind: 'album'; albumId: string }
  | { kind: 'bin'; libraryId: string }
  | { kind: 'missing'; libraryId: string }
  | { kind: 'no_shoot'; libraryId: string };

/** What names one collection, and so tells two of them apart. */
export function sourceKey(source: PhotoSource): string {
  switch (source.kind) {
    case 'library':
      return `library.${source.libraryId}`;
    case 'shoot':
      return `shoot.${source.shootId}`;
    case 'album':
      return `album.${source.albumId}`;
    case 'bin':
      return `bin.${source.libraryId}`;
    case 'missing':
      return `missing.${source.libraryId}`;
    case 'no_shoot':
      return `no-shoot.${source.libraryId}`;
  }
}

/** Where a collection's own grid lives. */
export function collectionPath(source: PhotoSource): string {
  switch (source.kind) {
    case 'shoot':
      return route(PathSegment.shoots(), source.shootId);
    case 'album':
      return route(PathSegment.albums(), source.albumId);
    case 'bin':
      return route(PathSegment.libraries(), source.libraryId, PathSegment.bin());
    case 'no_shoot':
      return route(PathSegment.libraries(), source.libraryId, PathSegment.noShoot());
    // The missing view has no grid route of its own, so it leaves by the library's.
    case 'library':
    case 'missing':
      return route(PathSegment.libraries(), source.libraryId);
  }
}

// The viewer and a triage session are nested under the collection they were
// opened from: a photo is in a shoot or an album as much as it is in a library,
// and one flat route cannot say which of them the reader is in. Without that a
// reload leaves by the wrong grid and steps through the wrong run.
export function photoPath(photoId: string, source: PhotoSource | null): string {
  const photo = route(PathSegment.photos(), photoId);
  return source == null ? photo : `${collectionPath(source)}${photo}`;
}

/**
 * Whether this row is a photograph composed out of others rather than imported.
 *
 * A fact about the row itself, which is what makes it simple: it draws from its own renditions, at
 * its own size. What it adds is the badge, and the band of frames the badge opens.
 */
export function isComposite(photo: PhotoStamps | null | undefined): boolean {
  return photo?.composite_kind != null;
}

export function triagePath(stackId: string, source: PhotoSource | null): string {
  const stack = route(PathSegment.stacks(), stackId, PathSegment.triage());
  return source == null ? stack : `${collectionPath(source)}${stack}`;
}

const COLLECTION_PATH = new RegExp(
  `^/(${PathSegment.libraries()}|${PathSegment.shoots()}|${PathSegment.albums()})/([^/]+)(/${PathSegment.bin()}|/${PathSegment.noShoot()})?/`,
);

/** The page for a carve job the server is running. */
export function mergeJobPath(jobId: string, source: PhotoSource | null): string {
  const path = route(PathSegment.photos(), PathSegment.merge(), jobId);
  return source == null ? path : `${collectionPath(source)}${path}`;
}

/** The page for re-picking a finished assembly. */
export function mergeEditPath(photoId: string, source: PhotoSource | null): string {
  const path = route(PathSegment.photos(), photoId, PathSegment.merge());
  return source == null ? path : `${collectionPath(source)}${path}`;
}

/** The collection a nested viewer or triage URL sits under. */
export function sourceOfPath(pathname: string): PhotoSource | null {
  const [, collection, id, within] = COLLECTION_PATH.exec(pathname) ?? [];
  if (id == null) return null;
  if (collection === PathSegment.shoots()) return { kind: 'shoot', shootId: id };
  if (collection === PathSegment.albums()) return { kind: 'album', albumId: id };
  if (within === route(PathSegment.bin())) return { kind: 'bin', libraryId: id };
  if (within === route(PathSegment.noShoot())) return { kind: 'no_shoot', libraryId: id };
  return { kind: 'library', libraryId: id };
}

/**
 * Whether the selection is one stack, and which way it is not: nothing stacked in
 * it at all, part of a stack, or more than a single whole one.
 */
export type StackSelection =
  | { kind: 'stack'; stackId: string }
  | { kind: 'none' }
  | { kind: 'partial' }
  | { kind: 'extra' };

/** More than this many frames is refused before the request is ever built. */
export const MERGE_MAX_FRAMES = 12;

/**
 * The selection as the merge menu asks about it: enough photographs, one library, none of them
 * itself a composite - or which of those it fails, checked in the order a reader would fix them.
 *
 * A **sample**, like `selectedStack`: only loaded rows answer, and a selection reaching further
 * than what this client holds refuses as `unresolved` rather than guessing. The count alone
 * answers `tooFew`/`tooMany` without needing a single row loaded, since positions carry no
 * per-photo fact the other three kinds need.
 */
export type MergeCandidate =
  | { kind: 'ready'; frames: PhotoSummary[] }
  | { kind: 'unresolved' }
  | { kind: 'tooFew' }
  | { kind: 'tooMany' }
  | { kind: 'mixedLibraries' }
  | { kind: 'hasComposite' };

// grid crops every tile to one aspect so rows line up and the eye can scan;
// masonry keeps each photo's own shape; list trades density for metadata.
export type ViewMode = 'grid' | 'masonry' | 'list';

/** The two stamps every built image URL is versioned by, and whether this row builds its camera view. */
export type PhotoStamps = Pick<PhotoSummary, 'tile_built_at' | 'renditions_built_at'> &
  Partial<Pick<PhotoSummary, 'composite_kind'>>;

// Which generation of a file to ask the server for, by the stamp of whatever
// produces its bytes: the import's tile pass for the grid, its rendition pass for
// the viewer's two. Each moves only when its own file did, so rebuilding a
// photo's renditions no longer re-fetches its grid tile.
//
// The row carries both, so this is known for the frame on screen and for a
// neighbour being warmed alike, it survives a reload, and every client agrees -
// none of which a version a client made up for itself could manage (§13.5). 0
// before that file has ever been written, which leaves the URL plain and the
// ETag in charge.
export function renditionVersion(photo: PhotoStamps | null | undefined, rendition: Rendition | ViewerRendition): number {
  // Nothing builds the camera's JPEG of a row that names a file, so no stamp describes it and
  // the ETag is the whole story. A canvas composites one, and then the URL has to move when it
  // lands: a frame that 404d is remembered by its source, so a copy built under the URL that
  // failed is a picture nothing asks for again (`retryEpoch`).
  if (rendition === 'embedded' && !isComposite(photo)) return 0;
  const stamp = rendition === 'grid' ? photo?.tile_built_at : photo?.renditions_built_at;
  return stamp == null ? 0 : Date.parse(stamp);
}

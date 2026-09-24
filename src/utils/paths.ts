import { lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { newId } from '../schemas/id';
import type { Library } from '../schemas/libraries';
import { soleInputOf, type StoredRecipe } from '../schemas/recipes';
import { RENDITION_EXTENSION, renditionVariant, type Rendition } from '../services/processing/renditions/renditions';

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
  return path.join(dataPath, 'renditions', renditionVariant(rendition, hdr), `${photoId}${RENDITION_EXTENSION}`);
}

export function getRenditionPath(library: Library, photoId: string, rendition: Rendition, hdr: boolean): string {
  return renditionPathFor(getDataPath(library), photoId, rendition, hdr);
}

/**
 * Where a draft's analysis layers live (§4.4): one directory per layer key, one file per source.
 *
 * `drafts/` rather than `renditions/` because the orphan sweep reads a rendition's filename as a
 * photo id and neither a layer key nor a source's position is one. These are reaped by age instead
 * (`PruneService.pruneDrafts`).
 */
export function draftLayerPath(dataPath: string, layerKey: string, at: number): string {
  return path.join(dataPath, 'drafts', layerKey, `${at}${RENDITION_EXTENSION}`);
}

/**
 * Where the render of one pick set lives (§4.2), beside the layers the page draws between picks.
 *
 * Keyed by what the picture is a function of rather than by the draft, so a reader stepping back to
 * a pick they have already seen is shown the file rather than a second render of it.
 */
export function draftPreviewPath(dataPath: string, layerKey: string, picture: string): string {
  return path.join(dataPath, 'drafts', layerKey, `preview-${picture}${RENDITION_EXTENSION}`);
}

/** Where a carve leaves the volume its seams are solved over, beside the layers it drew. */
export function draftVolumePath(dataPath: string, layerKey: string): string {
  return path.join(dataPath, 'drafts', layerKey, 'seams.bin');
}

/**
 * Where the scan leaves a grid tile it built while it had the RAW open (§10.4).
 *
 * **A name nobody has to derive twice.** The scan runs before the photo has an id - the row is
 * inserted after the whole library has been walked, and a file that turns out to be a move
 * never gets one - so the tile is written under a fresh id and that name is carried in scope
 * until the row exists. Then it is renamed to the photo's own, *in this same directory*, which
 * is atomic, cannot cross a filesystem, and is the whole of what adopting one costs.
 *
 * In `grid/` rather than a staging directory of its own, which is what makes the leftovers
 * free: one abandoned by a crash is a file in there whose name is not a live photo id, and the
 * orphan sweep already deletes exactly that (`PruneService`).
 */
export function scannedTilePath(dataPath: string): string {
  return renditionPathFor(dataPath, newId(), 'grid', false);
}

/** The stacking descriptor of a scanned tile, beside it, since it is computed off those pixels. */
export function stagedDescriptorPath(stagedTile: string): string {
  return `${stagedTile}.descriptor`;
}

/**
 * Where this photo's measurements are kept (`native/rawshim/src/photo_analysis.rs`).
 *
 * **Beside `renditions/` rather than inside it, and that is the whole point of the directory.**
 * A rendition is a cache: it can be deleted at any moment and the next request rebuilds it, and
 * the orphan sweep is free to take any file in there that no photo claims. This is not that. It
 * costs most of a second of measuring, almost all of which depends on nothing but the RAW, and
 * losing one is paying that again for every render, rebuild, editor open and loupe tile of that
 * photograph. So it lives one level up, where wiping the cache does not reach it.
 *
 * `<photoId>.bba`, so a filename still reads as an id if anything ever has to sweep these too.
 */
export function photoAnalysisPathFor(dataPath: string, photoId: string): string {
  return path.join(dataPath, 'analysis', `${photoId}.bba`);
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

// The ICC profiles a print can be proofed through, which a user puts there: beside the catalogue
// for the reason backups are, since `DATA_DIR` is theirs to clear.
export function printerProfilesDir(dbPath: string): string {
  return path.join(path.dirname(path.resolve(dbPath)), 'printer-profiles');
}

// A symlinked DB_PATH is a deliberate placement - the catalogue lives on another
// volume - and writing a restored file at the link's own path silently relocates
// it, orphaning the real one where nothing will ever look again. So everything
// that goes beside the catalogue comes through here, and every one of them means
// the same place by it: two spellings of one file are two answers to "is there a
// marker", and whichever of them is wrong is wrong in silence.
//
// `lstat` rather than `existsSync`, which follows the link: a link whose target is
// missing is exactly when this matters, because a volume that failed to mount is
// one of the two ways people arrive here. Reading it as "no catalogue" would put
// the restored file on top of the link and leave the real one unreachable.
export function resolveCatalogue(dbPath: string): string {
  let at = path.resolve(dbPath);
  // Chains, not just one link: a link into a link is what a re-pointed volume
  // leaves, and unwrapping only the first writes the restored catalogue into the
  // middle of the chain, leaving the real one live and orphaned. Bounded, because a
  // link that points at itself is a loop rather than a path.
  for (let hop = 0; hop < 32; hop++) {
    const link = lstatSync(at, { throwIfNoEntry: false });
    if (link?.isSymbolicLink() !== true) return at;
    at = path.resolve(path.dirname(at), readlinkSync(at));
  }
  throw new Error(`${dbPath} is a symlink loop`);
}

/**
 * A root-relative path inside a library, made absolute.
 *
 * Named for what it joins rather than for a photograph, and that is the point: a row's own file
 * is `originalPathOf` below, which answers for the recipe. This is for the callers holding a path
 * that is not a row's - where a binning came from, where a merged move left one.
 */
export function libraryPath(library: Library, relPath: string): string {
  return path.join(library.root_path, relPath);
}

/**
 * The file this photograph is, or null where it is not exactly one.
 *
 * The only way to a row's own bytes, and it reads the recipe because that is where the path is: a
 * row composed from several files has no single one, and there is no answer here that would not
 * be a guess at which of them the caller meant.
 */
export function originalPathOf(library: Library, photo: { recipe: StoredRecipe }): string | null {
  const relPath = soleInputOf(photo.recipe);
  return relPath == null ? null : libraryPath(library, relPath);
}

// A file_path value (root-relative, forward slashes) for an absolute path.
export function toLibraryRelative(rootPath: string, absPath: string): string {
  return path.relative(rootPath, absPath).split(path.sep).join('/');
}

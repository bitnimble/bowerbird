// One vocabulary for every derived copy of a photo (DESIGN §10.2).
//
// One name, not three trees called `thumbnails/`, `previews/` and `lossless/`, where
// `thumbnails/full` is a 3840px image the viewer shows by default and `previews/` is the
// one thing it does *not*. They are all the same idea at different sizes and dynamic
// ranges, so they are all renditions, and each exists for a stated reason:
//
//   grid      800px SDR, the library grid. Always SDR whatever the library is
//             set to: a wall of HDR tiles is punishing to look at, and it would
//             put a linear decode and two encoder passes on every import.
//   full      3840px, the photo view. HDR when the library asks for it.
//   max       native resolution, the pixel-peeping view. HDR likewise.
//   embedded  the cameras' own picture rather than ours, always SDR: a photograph's
//             own JPEG at whatever size it is, a canvas composited at the size the
//             photo view takes.
//
// **`embedded` is every row's, and how a row comes by one is its recipe's answer.**
// A row that names one file has the picture inside that file and hands it over
// unchanged - never resized, never transcoded, nothing on disk. A row composed out
// of others has no file to lift one out of, so its frames' pictures are composited
// into one and filed like any other copy; nothing queues that, and it is built when
// a reader opens it. Asking is the same question either way, which is why it is a
// rendition and not a route of its own.

import { RENDITIONS, type RenditionSource } from '../../../schemas/common';
import { type StoredRecipe } from '../../../schemas/recipes';
import { hasEmbeddedJpeg } from '../../../utils/scan';

export type Rendition = (typeof RENDITIONS)[number];

// One stored form of a photo: a rendition at a dynamic range. Five of these exist
// where three renditions do, because `full` and `max` are kept in both ranges, and
// they are what a photo actually has on disk - so this, not `Rendition`, is what
// anything per-file is keyed by: the directory the bytes are in, and the row in
// `renditions` saying which develop settings they were built from.
export type RenditionVariant = Rendition | `${Rendition}-hdr`;

// How much larger a composite's grid tile is than a photograph's. A canvas is several frames
// wide, so a tile framed to the same longest edge gives each frame a fraction of what one
// photograph's tile gives it, and the wall shows a row of smears.
export const PANORAMA_TILE_SCALE = 4;

export function isRendition(value: string): value is Rendition {
  return (RENDITIONS as readonly string[]).includes(value);
}

// Whether this rendition is built HDR in a library that asks for HDR. The grid
// tile never is (above), and neither is the composite's camera view, which is
// composed out of eight-bit JPEGs and has no headroom to carry. It is the library
// setting that every caller has to hand, so the exception lives here rather than
// at each of them: a reader that applied the setting to `grid` would look in a
// directory nothing ever writes and 404 every tile in the library.
//
// `processing_service.target` refuses it a second time, on the writing side. Not
// redundant: this decides where the bytes land and that decides what gets encoded,
// so without both a tile could be encoded HDR and filed as SDR.
export function storedAsHdr(rendition: Rendition, hdr: boolean): boolean {
  return hdr && rendition !== 'grid' && rendition !== 'embedded';
}

// HDR is stored beside the SDR copy rather than replacing it, so turning the
// setting off does not throw away work that turning it back on would redo. Each
// carries its own `built_from` stamp for that reason: one stamp over both would be
// a claim about whichever was written last, and the other would inherit it.
export function renditionVariant(rendition: Rendition, hdr: boolean): RenditionVariant {
  return storedAsHdr(rendition, hdr) ? `${rendition}-hdr` : rendition;
}

/**
 * A row whose copies are being decided about, whatever its recipe composes them from.
 *
 * The recipe rather than a flag, and the *inputs* rather than a path: a row is a recipe over one
 * or more files, and the base case is a list of one (`schemas/recipes`).
 */
export interface Buildable {
  recipe: StoredRecipe;
  /** The files behind it, root-relative or absolute: its own for a photograph, its frames' for a composite. */
  inputs: readonly string[];
  /**
   * Whether an edit is in play that the camera's own rendering could not carry.
   *
   * A photograph's own document, because an `embedded` library serves that JPEG as the file it
   * is and the edit would show in the editor and nowhere else. A composite's *frames'*
   * documents, for the same fault one row further out - a canvas built from the cameras' JPEGs
   * shows nothing a frame was graded with. Not a composite's own document, which is applied to
   * whatever it was composited from, the canvas going through the same grade and geometry either
   * way.
   */
  edited: boolean;
  /** What the viewer is served for this row, or null to follow the library. */
  photoSource: RenditionSource | null;
  librarySource: RenditionSource;
  /** Whether the library keeps HDR copies. */
  hdr: boolean;
}

/**
 * Which picture a row's copies are built from: the cameras' own rendering, or ours.
 *
 * **One rule for every recipe.** A photograph is a recipe over one file and a panorama a recipe
 * over twenty-six, and neither of them changes what the question is - so the answer is not a
 * panorama's to work out for itself, and a second copy of this rule is a second answer waiting to
 * disagree with the first.
 *
 * Three ways it comes out `render`, and none of them is a preference:
 *
 * - **anything is edited**, because a camera's JPEG cannot carry an edit. A photograph edited on
 *   an `embedded` library would otherwise show the change in the editor and nowhere else,
 *   permanently and with nothing saying why; a composite whose *frame* was edited is the same
 *   fault one row further out.
 * - **an input has no camera rendering to take**: a PNG, a HEIC, an AVIF, or a set holding one.
 *   Left saying `embedded` a row would owe no viewer copy at all and there would be nothing to
 *   open.
 * - **the library asks for ours**, which is the setting's whole purpose.
 */
export function sourceFor(row: Buildable): RenditionSource {
  if (row.edited) return 'render';
  if (row.inputs.length === 0 || !row.inputs.every(hasEmbeddedJpeg)) return 'render';
  return row.photoSource ?? row.librarySource;
}

/** One copy a row owes, and what it is built from. */
export interface Owed {
  rendition: Rendition;
  hdr: boolean;
  from: RenditionSource;
}

/**
 * The copies a row owes, in the order they are worth building: the tile the grid draws it with,
 * then the picture the viewer opens.
 *
 * `max` and `embedded` are not among them - they are what a reader asks for by name, and building
 * one of a canvas that may be four hundred megapixels at every merge is minutes nobody asked for.
 *
 * **A row shown the cameras' own picture owes nothing but the tile**, composite or not. A
 * photograph *is* that picture and is handed its own file; a canvas has no file to hand over, so
 * its copy is composited when a reader opens it (`PhotoRenditionService.buildRendition`), which is how
 * `max` and the camera view of a canvas have always been made. Queued at the merge instead, every
 * pan anybody groups costs a canvas of up to `panorama_full_rendition_size` composited, encoded
 * and filed before anyone has asked to see it - which is the whole of what a merge waits on.
 *
 * A library that renders is the other answer, and there the copy is owed: what the viewer is
 * promised there is ours, and a reader who opens a panorama on it should not be the one to pay
 * for a demosaic, a denoise and a defringe per frame.
 *
 * Its range is still the library's, and which variant this names is what the queue asks about
 * (`FULL_VARIANT_OF_LIBRARY`): a build that settled a different one would leave the row owing this
 * one for ever.
 */
export function owedOf(row: Buildable): readonly Owed[] {
  const from = sourceFor(row);
  const servedWhole = from === 'embedded';
  return [
    // Always SDR, as `storedAsHdr` says and for its reason.
    { rendition: 'grid', hdr: false, from },
    ...(servedWhole ? [] : [{ rendition: 'full' as const, hdr: row.hdr, from }]),
  ];
}

export const RENDITION_EXTENSION = '.avif';
export const RENDITION_CONTENT_TYPE = 'image/avif';

// Every form a photo can be stored in - and, since each is a directory named after
// itself, every directory the sweeps clear and the orphan search walks.
export function renditionVariants(): RenditionVariant[] {
  return RENDITIONS.flatMap((rendition) => [
    renditionVariant(rendition, false),
    ...(storedAsHdr(rendition, true) ? [renditionVariant(rendition, true)] : []),
  ]);
}

// Directories under `renditions/` that nothing writes any more, emptied by the
// prune sweep so an upgrade does not leave the disk holding files no code can
// name (§10.6). `<rendition>-hdr-video` held a one-frame AV1 copy of each HDR
// still, encoded for Firefox, which the client now makes for itself out of the
// still (§10.7).
export function retiredRenditionDirs(): string[] {
  return RENDITIONS.filter((rendition) => storedAsHdr(rendition, true)).map((rendition) => `${rendition}-hdr-video`);
}

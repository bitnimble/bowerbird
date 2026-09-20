import type { RenditionSource } from '../../../schemas/common';
import type { Library } from '../../../schemas/libraries';
import type { PhotoDetail, PhotoSummary } from '../../../schemas/photos';
import type { Settings, ViewerRendition, ViewerRenditionMode } from '../../../schemas/settings';
import { hasEmbeddedJpeg } from '../../../utils/scan';

/**
 * Everything the choice of rendition is a function of, gathered so the choice itself is
 * one function - asked once for the photo being read, once per row of a listing, always
 * the same way.
 *
 * `builtRenditions` is where the two callers differ, and it is a difference of what each
 * can afford to know rather than a second policy. A single-row read has already statted
 * every file to answer `PhotoDetail.renditions`, so it hands over the truth; a listing
 * would have to stat three files per row to match that, so it hands over what the row
 * already carries - `renditions_built_at` for `full`, nothing for `max`, which
 * `best_available` reads as "not yet". `isEdited` is the same trade for the same reason:
 * only a single-row read joins the edit document to know it.
 */
export interface RenditionContext {
  librarySource: RenditionSource;
  mode: ViewerRenditionMode;
  lastViewerRendition: ViewerRendition | null;
  rowViewerRendition: ViewerRendition | null;
  isEdited: boolean;
  /**
   * Whether a row this one is composed *from* carries a document, which is the same question one
   * row out and the one a composite is decided by: a canvas's own document reaches the picture
   * whichever way it was composited, where a frame's is an edit the cameras' JPEGs do not hold
   * (`renditions::sourceFor`). False for a photograph.
   */
  framesEdited: boolean;
  /**
   * Whether the cameras' own picture of this row can be had at all. For a row that names one
   * file that is `hasEmbeddedJpeg` - false for a PNG, a HEIC or an AVIF, which have nothing to
   * lift and no file to serve, so `embedded` is not a fallback for one, it is a 404 the viewer
   * would sit on. For a row composed out of others it is its frames' pictures, composited.
   */
  hasEmbedded: boolean;
  /**
   * Whether this row **composes** its camera view rather than passing one through
   * (`renditions::owedOf`, `servedWhole`).
   *
   * What it changes is which document decides - its frames' rather than its own - and that the
   * picture is a build rather than bytes already in a file, so the promise below is met by the
   * 404 that starts one.
   */
  composesCameraView: boolean;
  builtRenditions: ReadonlySet<ViewerRendition>;
  /**
   * Whether `builtRenditions` is a stat or a guess, which decides whether it may be drawn
   * from directly. A listing's is a guess in one direction that matters: `renditions_built_at`
   * is stamped by a run that wrote no `full` at all (`finishRenditions`), so a row can claim
   * one that is not there.
   */
  builtIsExact: boolean;
}

/**
 * What the viewer-rendition setting asks for, which may be a file this photograph does
 * not have. Never an answer to draw from on its own - `resolveShownRendition` is that -
 * because `remember` and `remember_per_photo` can each name nothing, and `max` is never
 * certain to exist.
 */
export function wantedRendition(ctx: RenditionContext): ViewerRendition | null {
  if (ctx.mode === 'remember') return ctx.lastViewerRendition;
  if (ctx.mode === 'remember_per_photo') return ctx.rowViewerRendition;
  if (ctx.mode === 'best_available') {
    if (ctx.builtRenditions.has('max')) return 'max';
    if (ctx.builtRenditions.has('full')) return 'full';
    // Nothing built and nothing to lift is the one case where "what is already there" is
    // nothing at all, and then the render is what this photograph is going to be shown from.
    return ctx.hasEmbedded ? 'embedded' : 'full';
  }
  return ctx.mode;
}

/**
 * The rendition to draw this photograph from, with no build and no round trip.
 *
 * **`guaranteed` is a promise, not a stat.** A library that renders promises `full` for
 * every photo it holds, and an edited photo is promised one whatever the library says -
 * `toStages` renders an edited photo regardless (`photo_edits_service.ts`) - so both name
 * `full` outright rather than asking whether this particular file has finished. Showing a
 * rendition on that promise, ahead of confirming it, is what lets a photo mid-import open
 * at the render it is about to have: the `<img>` may 404 once, and that 404 is what starts
 * the build (`ensureBuilt`, `ImageApi`) - the self-heal a stat-gated answer would skip
 * straight past, onto a photo silently stuck on the camera's JPEG.
 *
 * **Only `best_available` looks at what is actually built** (`wantedRendition`, above),
 * because its entire premise is "show me what is already there, and build nothing" - a
 * promise is exactly what it must not act on. Where that reading is a stat rather than a
 * guess it is also the one answer that needs no guarantee behind it, so it is drawn from
 * as it stands: capped to `guaranteed`, a `max` sitting on disk was reached by fetching
 * `full` first and swapping, which is two files and a visible change of picture to arrive
 * at the file the mode had already chosen.
 */
export function resolveShownRendition(ctx: RenditionContext): ViewerRendition {
  // A photograph with no camera JPEG behind it is promised the render whatever the library is
  // set to: the setting chooses between two sources and this one has only the one. So is anything
  // carrying an edit those pictures cannot - its own document for a photograph, its frames' for a
  // canvas, which is the distinction `renditions::sourceFor` draws and for the same reason.
  //
  // A canvas is otherwise promised the cameras' pictures exactly as a photograph is, and the fact
  // that it has to be composited rather than handed over is what the 404 above is for (§19.4).
  const editedPastTheJpeg = ctx.composesCameraView ? ctx.framesEdited : ctx.isEdited;
  const guaranteed: ViewerRendition =
    ctx.librarySource === 'render' || editedPastTheJpeg || !ctx.hasEmbedded ? 'full' : 'embedded';
  const wanted = wantedRendition(ctx);
  if (wanted == null) return guaranteed;
  // The camera's own picture is drawn from where there is one to draw. Bytes inside an original
  // are one from the moment the file is; a composited one is one once it has been composited.
  if (wanted === 'embedded') return ctx.builtRenditions.has('embedded') ? wanted : guaranteed;
  const confirmed = ctx.mode === 'best_available' && ctx.builtIsExact;
  return wanted === guaranteed || confirmed ? wanted : guaranteed;
}

/**
 * The rendition to build before this photograph can be read at what the setting actually
 * asks for, or null where `resolveShownRendition` already answers that.
 *
 * Worth doing only for the photograph being read: a neighbour the viewer is holding ready
 * gets `resolveShownRendition` alone; nobody is looking at it yet; asking a build for
 * every photo the viewer might hold would queue work for pictures nobody is looking at.
 */
export function resolveRenditionToBuild(ctx: RenditionContext): ViewerRendition | null {
  const shown = resolveShownRendition(ctx);
  // **A composited camera view is a file, and a row shown one that has none has to ask.** A
  // canvas is promised the cameras' pictures exactly as a photograph is, but it has no file to
  // lift them out of: they are its frames' JPEGs composited and filed like any other copy, and
  // nothing queues that (`renditions::owedOf`). Unasked, the library that serves the cameras'
  // pictures opens every canvas onto a 404 that never heals.
  if (shown === 'embedded' && ctx.composesCameraView && !ctx.builtRenditions.has('embedded')) {
    return 'embedded';
  }
  const wanted = wantedRendition(ctx);
  // Otherwise the camera's own picture is never *asked for* here. Where it is bytes inside an
  // original there is nothing to build, and naming one would send the client to a file that
  // cannot exist; where it is composited but not what this row is being opened at, it is minutes
  // of work, and the reader's own press is what starts one rather than the memory of a press made
  // on some other photograph. Either way it is shown once it is there
  // (`resolveShownRendition`).
  if (wanted === 'embedded') return null;
  return wanted != null && wanted !== shown ? wanted : null;
}

// What a single-row read already knows, having statted every file to answer
// `PhotoDetail.renditions`: whether this photograph has a camera JPEG in it at all, and
// whichever stored renditions are actually on disk right now.
export function builtSetFrom(renditions: PhotoDetail['renditions']): ReadonlySet<ViewerRendition> {
  const built = new Set<ViewerRendition>();
  if (renditions?.embedded.built === true) built.add('embedded');
  if (renditions?.full.built === true) built.add('full');
  if (renditions?.max.built === true) built.add('max');
  return built;
}

// What a listing's own columns already say, with no stat: `full` once the renditions
// stage has written it, and never `max`, which is built on request and leaves no column
// behind saying so (`processing_service.ts`).
export function builtSetFromRow(
  row: Pick<PhotoSummary, 'renditions_built_at' | 'file_path'>,
): ReadonlySet<ViewerRendition> {
  const built = new Set<ViewerRendition>();
  if (hasEmbeddedJpeg(row.file_path)) built.add('embedded');
  if (row.renditions_built_at != null) built.add('full');
  return built;
}

/**
 * The context a row answers for, which is every input but what is on disk.
 *
 * The library's current setting rather than the photo's own `rendition_source`, which
 * records what its renditions were last built *from*: this is a promise about what the
 * library serves, and a library just switched to rendering has photographs whose renders
 * are still being made. Naming the render is what makes the first of them 404 into the
 * build that produces it; naming what the last import happened to write would leave every
 * one of them on the camera's JPEG until something else reprocessed them.
 */
export function contextOf(
  row: Pick<PhotoSummary, 'viewer_rendition' | 'is_edited' | 'frames_edited' | 'file_path'>,
  library: Library | null,
  settings: Settings,
  builtRenditions: ReadonlySet<ViewerRendition>,
  builtIsExact: boolean,
  composesCameraView: boolean,
): RenditionContext {
  return {
    librarySource: library?.rendition_source ?? 'embedded',
    mode: settings.viewer_rendition_mode,
    lastViewerRendition: settings.last_viewer_rendition,
    rowViewerRendition: row.viewer_rendition,
    isEdited: row.is_edited,
    framesEdited: row.frames_edited,
    // One question over both arms: a row that names a file has the picture inside it, and a row
    // composed out of others has its frames'.
    hasEmbedded: composesCameraView || hasEmbeddedJpeg(row.file_path),
    composesCameraView,
    builtRenditions,
    builtIsExact,
  };
}

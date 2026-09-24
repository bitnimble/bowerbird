import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { EditDocSchema } from '../../schemas/photo_edits';
import type { PrepareDevelop } from '../../schemas/prepare_develop';
import { isComposite, soleInputOf } from '../../schemas/recipes';
import { PathSegment, route } from '../../schemas/route';
import { getDataPath, getRenditionPath } from '../../utils/paths';
import type { Originals } from '../../services/blobs/originals';
import { originalMediaType } from '../../utils/scan';
import { readEmbeddedJpeg, scrubIdentifying } from '../../services/processing/rawshim/raw_decoder';
import {
  readPhotoAnalysis,
  writePhotoAnalysis,
} from '../../services/processing/analysis/photo_analysis_store';
import { transcodeJpeg } from '../../services/processing/rawshim/rawshim_job';
import type { RenditionFetchService } from '../../services/blobs/rendition_fetch_service';
import { RENDITION_CONTENT_TYPE, isRendition } from '../../services/processing/renditions/renditions';
import type { ShareService } from '../../services/processing/exports/share_service';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import type { BasicPhoto } from '../../services/photos/paths/photo_paths_repository';
import type { PhotoRenditionService } from '../../services/photos/renditions/photo_rendition_service';
import type { Missing, Shown } from '../../services/processing/workers/prepare_pool';

// Where a variant's bytes live, given the photo it belongs to. Passing this in
// keeps `serve` about HTTP: adding a variant is a route, not another branch in
// a path-resolving conditional.
//
// A BasicPhoto, not a PhotoDetail: serving bytes needs an id, a library and a
// file path, and asking for the detail payload put a second query and a stat per
// rendition on every rendition in the grid (§8.2 `locate`).
// Awaited, because one of them is "the RAW, wherever it is" and that may be a fetch off a backup
// drive before there is a path to read (docs/replication.md §14.4).
type PathFor = (library: Library, photo: BasicPhoto) => string | null | Promise<string | null>;

type PreparesPictures = {
  preparePicture: (
    photoId: string,
    shown?: Shown,
    missing?: Missing,
    develop?: PrepareDevelop,
  ) => Promise<Uint8Array>;
  prepareRendition: (photoId: string, shown?: Shown, missing?: Missing) => Promise<Uint8Array>;
};

const JPEG_QUALITY = 92;

// Sentry's own ceiling on a report, which is the only thing that asks for a scrubbed original.
const SCRUBBED_ORIGINAL_CEILING = 40 * 1024 * 1024;

/**
 * What the prepare's query says a client can show, or undefined for the whole picture.
 *
 * **Undefined for anything malformed, rather than a refusal.** The worst a wrong query can do is
 * serve the overview, which is a picture; refusing it would leave a reader with a blank stage
 * because a fraction arrived as `NaN`. `region` is `x,y,w,h`, each a fraction of the picture.
 */
function shownIn(c: Context): Shown | undefined {
  const region = c.req.query('region');
  const stage = Number(c.req.query('stage'));
  if (region == null || !Number.isFinite(stage) || stage <= 0) return undefined;
  const parts = region.split(',').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const [x = 0, y = 0, width = 1, height = 1] = parts;
  if (width <= 0 || height <= 0) return undefined;
  return { region: { x, y, width, height }, stage };
}

const PrepareDevelopSchema = EditDocSchema.pick({
  luminanceNoise: true,
  colourNoise: true,
  denoiser: true,
  sharpening: true,
  dustRemoval: true,
  dustSensitivity: true,
  dustIntensity: true,
});

/**
 * The settings a client is previewing that run before the samples cross, as `develop`'s JSON, or
 * undefined for the stored document's. Undefined for anything malformed, for `shownIn`'s reason.
 */
function developIn(c: Context): PrepareDevelop | undefined {
  const develop = c.req.query('develop');
  if (develop == null) return undefined;
  try {
    const parsed = PrepareDevelopSchema.safeParse(JSON.parse(develop));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tiles a client says it is short of, or undefined where it named none.
 *
 * `at` is `left,top,width,height` in the pixels of `level`, which is the one place a client names
 * a level - `Missing` says why that is safe here and nowhere else. Refused as a whole rather than
 * in part: a half-read rectangle is a request for somewhere else in the picture, where a missing
 * one is just the region form instead.
 */
function missingIn(c: Context): Missing | undefined {
  const at = c.req.query('at');
  const level = Number(c.req.query('level'));
  if (at == null || !Number.isInteger(level) || level < 0) return undefined;
  const parts = at.split(',').map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0)) {
    return undefined;
  }
  const [x = 0, y = 0, width = 0, height = 0] = parts;
  if (width <= 0 || height <= 0) return undefined;
  return { level, rect: [x, y, width, height], tiles: tilesIn(c.req.query('parts')) };
}

/**
 * The individual squares inside `at`, as `x,y,w,h;x,y,w,h`.
 *
 * Empty for anything malformed or absent, which the library reads as "the whole of `at`" - the
 * behaviour before the squares were sent, and a picture either way. What they buy is the decode:
 * each source is opened for the box bounding *its own* squares, so an L costs what the L covers
 * rather than what its corner does.
 */
function tilesIn(parts: string | undefined): [number, number, number, number][] {
  if (parts == null || parts === '') return [];
  const each = parts.split(';').map((tile) => tile.split(',').map(Number));
  const whole = (part: number): boolean => Number.isInteger(part) && part >= 0;
  if (!each.every((tile) => tile.length === 4 && tile.every(whole))) return [];
  return each
    .map(([x = 0, y = 0, width = 0, height = 0]): [number, number, number, number] => [
      x,
      y,
      width,
      height,
    ])
    .filter(([, , width, height]) => width > 0 && height > 0);
}

// The viewer reports the weight of the rendition it is showing, and reads it off
// the response it already received rather than asking for a number the server
// would have to compute a second time (the camera's JPEG has no file on disk to
// stat, so its size is only known by extracting it, which is what serving it
// does anyway). Resource Timing hides body sizes cross-origin without this, and
// the app and the API are different origins in development.
const TIMING_ALLOW_ORIGIN = { 'Timing-Allow-Origin': '*' };

// Quotes and backslashes would end the header's quoted-string early, and a file
// on disk is free to contain either.
function attachment(filename: string): string {
  return `attachment; filename="${filename.replace(/["\\]/g, '')}"`;
}

// Every image is served from a stable URL over a file that can be rewritten
// under it, so the response has to carry a validator or a client keeps showing
// the old picture: with no ETag, no Last-Modified and no Cache-Control the
// browser caches heuristically with nothing to revalidate against, and with
// `no-cache` alone it cannot revalidate at all and re-fetches the whole body
// every time its copy falls out of memory. `no-cache` still caches, it just
// always asks first, which is a 304 in the common case.
//
// A freshness lifetime here would take that ask away, and with it the 404 that
// heals a rendition someone deleted out of `data/` - the conditional request per
// remount is what buys that, stamped URL or not (DESIGN §13.5).
function etagOf(file: { size: number; lastModified: number }): string {
  return `"${file.size}-${Math.floor(file.lastModified)}"`;
}

// Never cached: a download is a one-off, and the bytes for two of the four forms
// are produced per request anyway.
function download(body: Blob | Uint8Array, contentType: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': attachment(filename),
      'Cache-Control': 'no-cache',
    },
  });
}

// Streams straight from disk via Bun.file (no buffering); Bun.serve applies Range
// handling to the BunFile body for 206 partial content (DESIGN §13.5).
export class ImageApi {
  readonly routes: Hono;

  constructor(
    private readonly photoRead: PhotoReadService,
    private readonly photoRenditions: PhotoRenditionService,
    /**
     * How a rendition this device cannot build is asked of a peer (§7.9).
     *
     * Nullable but not defaulted, for the reason `PhotoRenditionService` gives: `null`
     * serves local files alone, which is right for a device that holds every
     * original, and an omission is that behaviour arrived at by accident.
     */
    private readonly fetchThrough: RenditionFetchService | null,
    /** The way to a photograph's bytes, wherever they are (§14.4). */
    private readonly originals: Originals,
    private readonly shares: ShareService,
    /**
     * What prepares one picture of a photograph for a client that will grade it itself.
     *
     * Nullable for the suites that mount this to ask about renditions and downloads: a null one
     * refuses the prepare by name rather than making every one of them build a processing
     * service to ignore.
     */
    private readonly pictures: PreparesPictures | null = null,
  ) {
    const app = new Hono();
    // One route for every rendition, named rather than spelled out per size: `grid`, `full`,
    // `max`, `embedded`. Dynamic range is not in the URL - the library decides it, and a client
    // guessing would ask for a file that was never built. There is no video form either, though
    // Firefox watches one: it makes that itself out of these bytes (§10.7).
    app.get(route(PathSegment.param('photoId'), PathSegment.renditions(), PathSegment.param('rendition')), async (c) => {
      const rendition = c.req.param('rendition') ?? '';
      if (!isRendition(rendition)) throw new AppError('NOT_FOUND', `unknown rendition: ${rendition}`);
      const photoId = c.req.param('photoId');
      if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
      // **Which copy is asked for is one question; how a row answers it is its recipe's.** The
      // cameras' own picture of a row that names one file is inside that file, and is handed
      // over unchanged - no resize, no transcode, nothing on disk (§10.2). The same picture of a
      // row composed out of others is composited from its frames' and filed like any other copy,
      // there being no file to lift one out of. Every other rendition is ours either way.
      const { photo, library } = this.photoRenditions.locate(photoId);
      if (rendition === 'embedded' && !isComposite(photo.recipe)) return this.serveEmbedded(photo, library, c);
      // A photo with no local original cannot be built here; a peer's built copy
      // is fetched and cached first, so the read below is an ordinary local one
      // (docs/replication.md §7.9).
      await this.fetchThrough?.ensureCurrent(photoId, rendition);
      // Looking at a photograph is wanting it, and the cull works in that order (§14.5). The two
      // the viewer draws and not the grid tile: scrolling past a thumbnail is not using the photo,
      // and a page of a hundred would be a hundred writes.
      if (rendition === 'full' || rendition === 'max') this.originals.touch(photoId);
      this.photoRenditions.rebuildIfStale(photoId);
      return this.serve(c, RENDITION_CONTENT_TYPE, (lib, each) =>
        getRenditionPath(lib, each.id, rendition, lib.rendition_hdr),
      );
    });
    // A rendition a client rendered on its own GPU, from the job `GET /api/photos/:id/renditions/:r/job`
    // handed it: gzipped `job::render_bytes` frames, which this side encodes and files.
    app.put(route(PathSegment.param('photoId'), PathSegment.renditions(), PathSegment.param('rendition')), async (c) => {
      const rendition = c.req.param('rendition') ?? '';
      if (!isRendition(rendition) || rendition === 'grid') {
        throw new AppError('NOT_FOUND', `not a rendition a client renders: ${rendition}`);
      }
      const photoId = c.req.param('photoId');
      if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
      const rendered = gunzipSync(new Uint8Array(await c.req.arrayBuffer()), { maxOutputLength: 512 * 1024 * 1024 });
      await this.photoRenditions.keepRendition(photoId, rendition, c.req.query('builtFrom') ?? null, rendered);
      return new Response(null, { status: 204, headers: TIMING_ALLOW_ORIGIN });
    });
    // Every form the viewer offers to take away, as an attachment: the RAW, the
    // camera's JPEG, and either rendered rendition. One route because the menu
    // offering them is one list and only the bytes differ.
    app.get(route(PathSegment.param('photoId'), PathSegment.download(), PathSegment.param('form')), (c) => this.serveDownload(c));
    // Where the RAW is on this server's disk, for the desktop app to hand to another application.
    app.get(route(PathSegment.param('photoId'), PathSegment.original()), async (c) => {
      const photoId = c.req.param('photoId');
      const { photo, library } = this.photoRenditions.locate(photoId);
      const path = await this.originals.open(library, photo);
      if (path == null) throw new AppError('NOT_FOUND', `this photo has no RAW on this device: ${photoId}`);
      return c.json({ path });
    });
    // The same picture the viewer is showing, as the one format a share sheet can hand to
    // anything (§10.5). Which rendition is in the URL where a download names a form: this is
    // what is on screen, and the client is the only side that knows which that is.
    app.get(route(PathSegment.param('photoId'), PathSegment.share(), PathSegment.param('rendition')), (c) => this.serveShare(c));
    // A link preview's picture. JPEG because most unfurlers refuse AVIF.
    app.get(route(PathSegment.param('photoId'), PathSegment.preview()), (c) => this.servePreview(c));
    // What has been measured about this photograph, for a client that is going to open the RAW
    // itself. Most of a second of fitting that depends on nothing but the file, so a client
    // holding it skips the slowest part of an open it did not have to do at all.
    app.get(route(PathSegment.param('photoId'), PathSegment.analysis()), (c) => this.servePhotoAnalysis(c));
    app.put(route(PathSegment.param('photoId'), PathSegment.analysis()), (c) => this.keepPhotoAnalysis(c));
    // One picture of this photograph, coded, for a client that will grade it itself. What makes a
    // composite openable at all: the editor holds one frame and a panorama is several, so what
    // crosses is the canvas rather than the sources behind it.
    app.get(route(PathSegment.param('photoId'), PathSegment.prepare()), (c) => this.servePrepared(c));
    this.routes = app;
  }

  /**
   * The stored analysis, or a 404 where nothing has measured this photograph yet.
   *
   * **Bytes, opaquely.** `photo_analysis.rs` writes it and reads it back; nothing on this side
   * interprets it, and a build that cannot read a blob ignores it and measures again, so there is
   * no version to negotiate here.
   *
   * No validator either, unlike everything else served here: the file grows as different callers
   * measure different parts of it, so a client that asked before a peak existed has a reason to
   * take the whole thing again rather than to be told it has not changed.
   */
  private servePhotoAnalysis(c: Context): Response {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { library } = this.photoRenditions.locate(photoId);
    const analysis = readPhotoAnalysis(getDataPath(library), photoId);
    if (analysis == null) {
      throw new AppError('NOT_FOUND', `nothing has been measured for ${photoId}`);
    }
    return new Response(Uint8Array.from(analysis), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...TIMING_ALLOW_ORIGIN,
      },
    });
  }

  /**
   * One picture of this photograph, coded, for a client that will grade it itself.
   *
   * **The numbers come back in the body, not beside it.** The reply is framed - a `u32` header
   * length, that much JSON, padding to a word, then the samples - because the desktop shell's
   * proxy keeps seven response headers and drops everything else, so a header naming the levels
   * and the colour match would reach the webview empty (`src-tauri/src/api.rs`).
   *
   * **The URL says what the client can show, never which level to serve.** With nothing, the
   * whole picture at the coarsest level it has, which is what a reader opens on. With `region`
   * as four fractions of the picture and `stage` as the long edge it has to draw them on, the
   * window of whichever level puts a sample on each of those pixels - which is how a reader
   * reaches a canvas's own pixels past the point where a whole level fits.
   *
   * A client naming a level would be a second implementation of the arithmetic *and* a way to
   * ask for a picture no adapter will hold a texture of - and it would have to ask before it
   * could know, since the canvas is the recipe's rather than the row's. Fractions rather than
   * pixels for the same reason: a client that had to state the canvas's own coordinates would
   * have to be told the canvas first.
   *
   * Never stored. The body is tens to a hundred megabytes, so a cache of it would evict
   * everything a reader is browsing to hold one they are editing - and what it is a function of
   * includes a library setting, the document, and every source's own analysis, so an entry that
   * outlived any of those would serve a picture the grade is no longer anchored to.
   *
   * `from=rendition` prepares the photograph's full rendition instead, edits and all, for a client
   * that shows the picture rather than editing it.
   */
  private async servePrepared(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    if (this.pictures == null) {
      throw new AppError('NOT_FOUND', 'this server does not prepare pictures');
    }
    // Refused here rather than resolved, so the reason names the photograph: `locate` is what
    // says whether this id is one at all.
    const { photo, library } = this.photoRenditions.locate(photoId);
    const framed = c.req.query('from') === 'rendition'
      ? await this.preparedRendition(this.pictures, photoId, c)
      : await this.preparedPicture(this.pictures, photo, library, c);
    return new Response(framed, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        ...TIMING_ALLOW_ORIGIN,
      },
    });
  }

  private async preparedPicture(
    pictures: PreparesPictures,
    photo: BasicPhoto,
    library: Library,
    c: Context,
  ): Promise<Uint8Array> {
    // What tells a composite this device cannot compose apart from an ordinary photograph is
    // whether the frames are on this disk, so a photograph given up to a backup is fetched
    // before the prepare asks (§14.4).
    await this.originals.openAll(library, photo);
    return pictures.preparePicture(photo.id, shownIn(c), missingIn(c), developIn(c));
  }

  private async preparedRendition(
    pictures: PreparesPictures,
    photoId: string,
    c: Context,
  ): Promise<Uint8Array> {
    // Built or fetched from a peer where it is missing or behind the edits, as the viewer's own
    // request for it would be.
    await this.photoRenditions.buildRendition(photoId, 'full');
    return pictures.prepareRendition(photoId, shownIn(c), missingIn(c));
  }

  /**
   * What a client measured, kept so the next open does not measure it again.
   *
   * **Last writer wins, and what that can cost is one re-measurement.** A client sends back
   * everything it was handed plus whatever it worked out itself - the open merges the two before
   * encoding (`PhotoAnalysis::filled_from`) - so a write is normally a superset of what is on disk.
   * Two clients racing with different halves can still drop one of them, and then the next open
   * measures that half again, which is the same outcome as the file never having existed.
   *
   * The bytes are opaque here, as they are on the way out: a build that cannot read a blob ignores
   * it and measures again, so there is no version to negotiate at this boundary.
   */
  private async keepPhotoAnalysis(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { library } = this.photoRenditions.locate(photoId);

    const analysis = new Uint8Array(await c.req.arrayBuffer());
    // A ceiling only. This writes into the library's own data directory under an id the caller
    // chose, so the size is worth bounding above - but a *small* analysis is an ordinary one: a
    // photograph whose glass was read and found clean stores an empty particle list and nothing
    // else, which is a dozen bytes and is exactly the answer worth keeping. A floor here rejected
    // it, the write is fire-and-forget so the refusal was never seen, and the photograph searched
    // its whole mosaic again on every open.
    if (analysis.length > 4 * 1024 * 1024) {
      throw new AppError('VALIDATION_ERROR', `a photo analysis is not ${analysis.length} bytes`);
    }
    writePhotoAnalysis(getDataPath(library), photoId, analysis);
    return new Response(null, { status: 204, headers: TIMING_ALLOW_ORIGIN });
  }

  // The camera's own JPEG, lifted out of the RAW and tagged for display. No
  // demosaic and nothing cached on disk: extraction is a header read plus a copy,
  // which is cheaper than the disk a fourth derivative per photo would cost.
  private async serveEmbedded(photo: BasicPhoto, library: Library, c: Context): Promise<Response> {
    const photoId = photo.id;
    const originalPath = await this.originals.open(library, photo);
    if (originalPath == null) throw new AppError('NOT_FOUND', `this photograph has no file to lift a JPEG out of: ${photoId}`);
    // The RAW, not the JPEG inside it: these bytes are part of that file, so its
    // stat moves exactly when they do.
    const rotate = this.photoRead.editOrientation(photoId);
    const originalEtag = etagOf(Bun.file(originalPath));
    const etag = rotate === 0 ? originalEtag : originalEtag.slice(0, -1) + '-' + rotate + '"';
    const headers = {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...TIMING_ALLOW_ORIGIN,
    };
    // Ahead of the extraction, which is the whole cost of this route.
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });

    const jpeg = readEmbeddedJpeg(originalPath, rotate);
    if (jpeg == null) throw new AppError('NOT_FOUND', `this file has no embedded JPEG: ${photoId}`);
    return new Response(new Uint8Array(jpeg), { headers });
  }

  /**
   * One rendition, re-encoded for the platform's share sheet.
   *
   * Never cached: the bytes exist for this share and are made again for the next one.
   */
  private async serveShare(c: Context): Promise<Response> {
    const rendition = c.req.param('rendition') ?? '';
    if (rendition !== 'full' && rendition !== 'max' && rendition !== 'embedded') {
      throw new AppError('NOT_FOUND', `nothing to share as ${rendition}`);
    }
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const bytes = await this.shares.jpeg(photoId, rendition);
    return new Response(bytes, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', ...TIMING_ALLOW_ORIGIN },
    });
  }

  private async servePreview(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photoRenditions.locate(photoId);
    const tilePath = getRenditionPath(library, photo.id, 'grid', false);
    const tile = Bun.file(tilePath);
    if (!(await tile.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
    const etag = etagOf(tile);
    const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ETag: etag };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(transcodeJpeg(tilePath, 0, JPEG_QUALITY)), { headers });
  }

  // One of the four things a photo can be taken away as. The RAW goes over as it
  // is; the camera's JPEG is lifted out of it; `full` and `max` come from the
  // stored rendition, transcoded to JPEG only where the library is SDR - because a
  // download is occasional and a JPEG per rendition on disk would cost more than
  // the transcode does, while an HDR rendition has nothing to gain from one.
  //
  // The rendition has to be on disk already: building it is the viewer's request
  // (`POST /api/photos/:id/renditions/:r`), and a download that silently took
  // minutes would look like a hung browser.
  private async serveDownload(c: Context): Promise<Response> {
    const form = c.req.param('form') ?? '';
    // What a bug report attaches (§18.8). Not a download's default: a reader taking their own
    // photograph away wants the file the camera wrote, coordinates and all.
    const scrub = c.req.query('scrub') === '1';
    if (form === 'original' && scrub) return this.serveScrubbedOriginal(c);
    // The RAW goes out through the file path every other stored file takes, so a
    // client can still seek inside a 25MB download (§13.5). No extension assumed
    // in the URL: a catalogue holds more than one RAW format, so both the media
    // type and the name it lands under come off the file itself.
    if (form === 'original') {
      return this.serve(
        c,
        (photo) => originalMediaType(soleInputOf(photo.recipe) ?? ''),
        (lib, photo) => this.originals.open(lib, photo),
        (photo) => soleInputOf(photo.recipe)?.split('/').pop() ?? photo.id,
      );
    }

    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photoRenditions.locate(photoId);
    // The id for a row with no file of its own, which has no filename to take a stem from.
    const stem = (soleInputOf(photo.recipe)?.split('/').pop() ?? photo.id).replace(/\.[^.]+$/, '');

    if (form === 'embedded') {
      const original = await this.originals.open(library, photo);
      const jpeg = original == null ? null : readEmbeddedJpeg(original, this.photoRead.editOrientation(photoId));
      if (jpeg == null) throw new AppError('NOT_FOUND', `this file has no embedded JPEG: ${photoId}`);
      // Refused rather than sent as it is, for `serveScrubbedOriginal`'s reason: a preview
      // carries the same coordinates the original does.
      if (scrub && !scrubIdentifying(jpeg)) {
        throw new AppError('VALIDATION_ERROR', `identifying data cannot be removed from the preview of ${stem}`);
      }
      return download(new Uint8Array(jpeg), 'image/jpeg', `${stem}-embedded.jpg`);
    }

    if (form !== 'full' && form !== 'max') throw new AppError('NOT_FOUND', `unknown download: ${form}`);
    const renditionPath = getRenditionPath(library, photo.id, form, library.rendition_hdr);
    if (!(await Bun.file(renditionPath).exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
    // Suffixed, because a reader comparing the two renders wants both in the same
    // folder and one name twice is one file and a copy.
    const name = `${stem}-${form === 'max' ? 'rendered-max' : 'rendered'}`;

    // An HDR library's renditions go over as they are. JPEG cannot carry PQ, so
    // transcoding one would hand back an SDR tone-map of the picture on screen and
    // call it the same render - and the AVIF is already the format the viewer showed.
    if (library.rendition_hdr) {
      return download(Bun.file(renditionPath), RENDITION_CONTENT_TYPE, `${name}.avif`);
    }

    // One call, given the path: the rendition's own bytes have no business on this
    // side and never reach it, and the JPEG that does is a response body. Nothing
    // is held between calls, so there is no handle to free on the way out.
    const jpeg = transcodeJpeg(renditionPath, 0, JPEG_QUALITY);
    return download(new Uint8Array(jpeg), 'image/jpeg', `${name}.jpg`);
  }

  /**
   * The RAW with every identifying tag blanked, for a bug report to attach (§18.8).
   *
   * Read whole rather than streamed, unlike the download beside it: the scrub walks the file's
   * directories and its previews, so there is nothing to send until all of it has been seen.
   *
   * **A container the library cannot read is refused.** Handing back the file unscrubbed would
   * answer a request to remove somebody's coordinates by sending them.
   */
  private async serveScrubbedOriginal(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photoRenditions.locate(photoId);
    const original = await this.originals.open(library, photo);
    if (original == null) throw new AppError('NOT_FOUND', `${photoId} has no file of its own`);

    const name = soleInputOf(photo.recipe)?.split('/').pop() ?? photo.id;
    const file = Bun.file(original);
    // Bounded before the read, not after: the download beside this one streams, so it is this
    // route alone that holds a whole RAW in memory, and a request per photograph in a library
    // of 60MB files is the server out of memory rather than a slow response.
    if (file.size > SCRUBBED_ORIGINAL_CEILING) {
      throw new AppError('VALIDATION_ERROR', `${name} is too large to have its identifying data removed`);
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!scrubIdentifying(bytes)) {
      throw new AppError('VALIDATION_ERROR', `identifying data cannot be removed from ${name}`);
    }
    return download(new Uint8Array(bytes), originalMediaType(soleInputOf(photo.recipe) ?? ''), name);
  }

  // 404s go through AppError (not c.notFound()) so every not-available response
  // shares the standard JSON envelope. locate already throws NOT_FOUND.
  //
  // Soft-deleted photos are served, not hidden: the Bin is a browsable view that
  // a user restores from, and it is unusable if every frame in it is a grey box.
  // The row and both files still exist, so there is nothing to withhold.
  private async serve(
    c: Context,
    contentType: string | ((photo: BasicPhoto) => string),
    pathFor: PathFor,
    downloadAs?: (photo: BasicPhoto) => string,
  ): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photoRenditions.locate(photoId);

    const target = await pathFor(library, photo);
    // Null rather than absent: a row composed out of others has no original, so this is not a
    // file that has gone missing and no rebuild will produce one.
    if (target == null) throw new AppError('NOT_FOUND', `${photoId} has no file of its own`);
    const file = Bun.file(target);
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    const etag = etagOf(file);
    const headers = {
      'Content-Type': typeof contentType === 'string' ? contentType : contentType(photo),
      // Bun.serve answers Range requests against a BunFile body but doesn't
      // advertise it; without this a client can't know it may seek a 25MB RAW.
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...TIMING_ALLOW_ORIGIN,
      ...(downloadAs == null ? {} : { 'Content-Disposition': attachment(downloadAs(photo)) }),
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });

    return new Response(file, { headers });
  }
}

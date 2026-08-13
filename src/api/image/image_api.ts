import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import type { Library } from '../../schemas/libraries';
import { getDataPath, getOriginalPath, getRenditionPath } from '../../utils/paths';
import { rawMediaType } from '../../utils/scan';
import { readEmbeddedJpeg } from '../../services/processing/raw_decoder';
import { headerOf, prepareEditAsync } from '../../services/processing/rawshim_edit';
import { readCameraMatch, writeCameraMatch } from '../../services/processing/camera_match_store';
import { transcodeJpeg, type NoiseFit } from '../../services/processing/rawshim_job';
import type { SettingsRepository } from '../../services/settings/settings_repository';
import { RENDITION_CONTENT_TYPE, isRendition } from '../../services/processing/renditions';
import type { BasicPhoto } from '../../services/photos/photos_repository';
import type { PhotosService } from '../../services/photos/photos_service';

// Where a variant's bytes live, given the photo it belongs to. Passing this in
// keeps `serve` about HTTP: adding a variant is a route, not another branch in
// a path-resolving conditional.
//
// A BasicPhoto, not a PhotoDetail: serving bytes needs an id, a library and a
// file path, and asking for the detail payload put a second query and a stat per
// rendition on every rendition in the grid (§8.2 `locate`).
type PathFor = (library: Library, photo: BasicPhoto) => string;

/**
 * One tile of a photograph, graded through the reader's own edits.
 *
 * Structural rather than the whole `ProcessingService`: this route wants one method, and a test
 * that exercises it should not have to stand up an import queue to get it.
 */
type TileRenderer = (
  rawFilePath: string,
  photoId: string,
  library: Library,
  tile: [number, number, number, number],
  noiseFit?: NoiseFit,
) => Uint8Array;

const JPEG_QUALITY = 92;

const log = new Logger('image');

// What the editor asks for when the client names nothing: the sensor, whatever it is.
//
// It used to be 3840 with a 6144 ceiling, because a tick cost what the frame cost and a
// 61MP grade at sixty frames a second was not on offer. It no longer does - the draw runs
// once per canvas pixel, so opening the whole sensor buys 1:1 detail and costs nothing per
// tick (`docs/raw-edit-gpu.md` §6) - and holding the cap would just mean a reader who
// zooms in sees a frame the decode threw away.
//
// A number the client names is still honoured, since it knows what its stage can hold; the
// decode never enlarges, so asking for more than the sensor has is the sensor.
const DEFAULT_EDIT_EDGE = 0;

// A ceiling on what a client may ask for. Well past any sensor - a 61MP body's long edge is
// 9504 - because the decode never enlarges, so every value between here and there already
// meant "the sensor" and still does. What this changes is only the absurd end: `long_edge`
// crosses as a `u32`, and serde refuses one that will not fit rather than truncating it, so
// `longEdge=5000000000` used to spawn a thread, fail to parse the request inside it, and come
// back a 500. The same answer, arrived at before any of that, and as the 400 it always was.
const MAX_EDIT_EDGE = 100_000;

// What a loupe tile's sides may be. The floor is the mosaic denoise's own: below 64 the chroma
// pyramid has no quarter-resolution level to build. The ceiling is what keeps a tile a tile -
// past this it is a rendition, it costs like one, and there is a route that caches those.
const MIN_TILE = 64;
const MAX_TILE = 2048;

/**
 * The frame's noise as the editor's open measured it, off a tile request's `noise` parameter.
 *
 * Seven numbers, comma-separated, in `galosh::NoiseFit`'s own order. Round-tripped rather than
 * read: nothing on this side interprets them, and the native side refuses a fit that does not
 * describe a sensor, so a malformed one is dropped here and the tile measures its own.
 */
function noiseFitOf(words: string | undefined): NoiseFit | undefined {
  if (words == null) return undefined;
  const parts = words.split(',').map(Number);
  if (parts.length !== 7 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [alpha, sigmaSq, unifiedSigma, ...darkRef] = parts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return { alpha, sigmaSq, unifiedSigma, darkRef };
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
    private readonly photos: PhotosService,
    private readonly settings: SettingsRepository,
    /** Renders a loupe tile, which is the one thing here that needs the reader's own edits. */
    private readonly processing: { renderTile: TileRenderer },
  ) {
    const app = new Hono();
    // One route for every stored rendition, named rather than spelled out per
    // size: `grid`, `full`, `max`. Dynamic range is not in the URL - the library
    // decides it, and a client guessing would ask for a file that was never
    // built. There is no video form either, though Firefox watches one: it makes
    // that itself out of these bytes (§10.7).
    app.get('/:photoId/renditions/:rendition', (c) => {
      const rendition = c.req.param('rendition') ?? '';
      if (!isRendition(rendition)) throw new AppError('NOT_FOUND', `unknown rendition: ${rendition}`);
      return this.serve(c, RENDITION_CONTENT_TYPE, (lib, photo) =>
        getRenditionPath(lib, photo.id, rendition, lib.rendition_hdr),
      );
    });
    // Served as the camera wrote it, never resized or transcoded into a stored
    // rendition of its own (§10.2). The RAW itself goes the same way.
    app.get('/:photoId/embedded.jpg', (c) => this.serveEmbedded(c));
    // Every form the viewer offers to take away, as an attachment: the RAW, the
    // camera's JPEG, and either rendered rendition. One route because the menu
    // offering them is one list and only the bytes differ.
    app.get('/:photoId/download/:form', (c) => this.serveDownload(c));
    // The editor's open. Everything before the first slider tick happens here, on real
    // threads, and what goes over is the frame every tick then grades on the GPU
    // (`docs/raw-edit-gpu.md` §6, §10.2b). The desktop shell runs the same call in
    // process; this is the browser's transport for it.
    app.get('/:photoId/prepared', (c) => this.servePrepared(c));
    // One tile of the photograph at rendition quality, which is what the loupe magnifies.
    app.get('/:photoId/tile', (c) => this.serveTile(c));
    this.routes = app;
  }

  /**
   * A crop of the photograph, decoded, denoised on the mosaic and graded - the export's own
   * pipeline, on the part the reader is holding a magnifier over.
   *
   * **Nothing is kept between requests, and that is the design rather than a shortcut.**
   * `params.cropbox` restricts the demosaic's own work and the mosaic denoise takes a window,
   * so a tile is an unpack and two small pieces of work - about 110ms for a 400px tile of a
   * 24MP frame, against 3.1 seconds for the whole of it. Because nothing is cached, a tile is a
   * pure function of the query, so there is no invalidation to get wrong when a slider moves:
   * the client keys its own cache on the same values and a stale one cannot be served.
   *
   * The editor keeps showing its own render underneath until this lands, so the latency is a
   * sharpening rather than a wait.
   */
  private async serveTile(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);

    const asked = ['left', 'top', 'width', 'height'].map((name) => Number(c.req.query(name)));
    if (asked.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new AppError('VALIDATION_ERROR', 'a tile is left, top, width and height in pixels');
    }
    const [left, top, width, height] = asked.map(Math.round) as [number, number, number, number];
    // Bounded here rather than several layers down, for the reason `servePrepared` gives: a
    // size the native side will refuse still crosses the FFI and unpacks a RAW first.
    if (width < MIN_TILE || height < MIN_TILE || width > MAX_TILE || height > MAX_TILE) {
      throw new AppError(
        'VALIDATION_ERROR',
        `a tile's sides are between ${MIN_TILE} and ${MAX_TILE}: ${width}x${height}`,
      );
    }

    const original = getOriginalPath(library, photo.file_path);
    if (!(await Bun.file(original).exists())) {
      throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
    }

    // Through the processing service, which is where the reader's stored edits already become
    // job fields: a loupe showing anything else would be magnifying a photograph nobody is
    // about to export.
    // **Timed separately from the request, because the two answer different questions.** The
    // access log measures arrival to response, so a tile that waited behind another reads as a
    // slow render - and this handler is synchronous, so during a pointer sweep several arrive
    // at once and every one of them reports the queue as its own cost. When these two numbers
    // disagree, the gap is the wait and not the renderer.
    const started = Bun.nanoseconds();
    const tile = this.processing.renderTile(
      original,
      photoId,
      library,
      [left, top, width, height],
      noiseFitOf(c.req.query('noise')),
    );
    log.info('rendered a loupe tile', {
      photoId,
      tile: `${width}x${height}+${left}+${top}`,
      renderMs: Math.round((Bun.nanoseconds() - started) / 1e6),
    });

    return new Response(new Uint8Array(tile), {
      headers: {
        'Content-Type': 'image/avif',
        // The client caches these itself, keyed on the same values this is a function of, so
        // there is nothing for a shared cache to get wrong or to hold.
        'Cache-Control': 'no-store',
        ...TIMING_ALLOW_ORIGIN,
      },
    });
  }

  // Seconds of work and hundreds of megabytes back, so it is a GET a client makes once per
  // photo rather than per tick. `longEdge` is the client's, not the library's: the stage
  // decides how many pixels are worth grading (§4.1), and the rendition default is a size
  // chosen for a file kept forever.
  private async servePrepared(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);

    const requested = Number(c.req.query('longEdge') ?? DEFAULT_EDIT_EDGE);
    // Bounded at both ends, and answered here rather than several layers down: a number the
    // native side will refuse still crosses the FFI and starts a thread first, and comes back
    // as a 500 for what the reader plainly got wrong.
    if (!Number.isFinite(requested) || requested < 0 || requested > MAX_EDIT_EDGE) {
      throw new AppError(
        'VALIDATION_ERROR',
        `longEdge must be between 0 and ${MAX_EDIT_EDGE}: ${requested}`,
      );
    }
    const longEdge = Math.round(requested);

    // Before the open rather than after it. `locate` answers from the catalogue, which knows
    // nothing about the disk, so a file that has been moved or unplugged reaches the decoder as a
    // path that is not there - and comes back as a 500 quoting the server's own absolute
    // path, where every sibling route here answers 404. The reader's own library is not a
    // server error, and where it lives is not theirs to be told.
    const original = getOriginalPath(library, photo.file_path);
    if (!(await Bun.file(original).exists())) {
      throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
    }

    const settings = this.settings.get();
    // Awaited, not called: the open is seconds of decoding, and every other request this
    // server answers comes off the same thread. It runs on one the native side owns and
    // reports back through a callback (`rawshim_edit.ts`), so a reader opening the editor no
    // longer stops the grid loading for anybody, themselves included.
    const dataPath = getDataPath(library);
    const prepared = await prepareEditAsync({
      rawFilePath: original,
      // Half a second of the open, kept from whatever fitted it first (`camera_match_store`).
      cameraMatch: readCameraMatch(dataPath, photoId),
      longEdge,
      grade: {
        peakNits: settings.hdr_peak_nits,
        referenceWhiteNits: settings.hdr_reference_white_nits,
        whiteQuantile: settings.hdr_white_quantile,
      },
      // No denoise: the frame the editor is handed carries its noise, and the client
      // removes it in its own tick so the Detail sliders can move without a re-open.
      strengths: {
        sharpen: settings.raw_sharpen,
        defringe: settings.raw_defringe,
      },
    });

    // Kept if this open had to fit it, which is half a second off every later open, render and
    // loupe tile of this photograph. Reading the header back costs one JSON parse of a few
    // kilobytes in front of a frame that is hundreds of megabytes.
    const fitted = headerOf(prepared).cameraMatch;
    if (fitted != null) writeCameraMatch(dataPath, photoId, Uint8Array.from(fitted));

    return new Response(prepared, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        ...TIMING_ALLOW_ORIGIN,
      },
    });
  }

  // The camera's own JPEG, lifted out of the RAW and handed over unchanged. No
  // demosaic and nothing cached: extraction is a header read plus a copy, which
  // is cheaper than the disk a fourth derivative per photo would cost.
  private async serveEmbedded(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);

    const jpeg = readEmbeddedJpeg(getOriginalPath(library, photo.file_path));
    if (jpeg == null) throw new AppError('NOT_FOUND', `this file has no embedded JPEG: ${photoId}`);
    return new Response(new Uint8Array(jpeg), {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ...TIMING_ALLOW_ORIGIN },
    });
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
    // The RAW goes out through the file path every other stored file takes, so a
    // client can still seek inside a 25MB download (§13.5). No extension assumed
    // in the URL: a catalogue holds more than one RAW format, so both the media
    // type and the name it lands under come off the file itself.
    if (form === 'original') {
      return this.serve(
        c,
        (photo) => rawMediaType(photo.file_path),
        (lib, photo) => getOriginalPath(lib, photo.file_path),
        (photo) => photo.file_path.split('/').pop() ?? photo.id,
      );
    }

    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);
    const stem = (photo.file_path.split('/').pop() ?? photo.id).replace(/\.[^.]+$/, '');

    if (form === 'embedded') {
      const jpeg = readEmbeddedJpeg(getOriginalPath(library, photo.file_path));
      if (jpeg == null) throw new AppError('NOT_FOUND', `this file has no embedded JPEG: ${photoId}`);
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

  // 404s go through AppError (not c.notFound()) so every not-available response
  // shares the standard JSON envelope. this.photos.locate already throws NOT_FOUND.
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
    const { photo, library } = this.photos.locate(photoId);

    const file = Bun.file(pathFor(library, photo));
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    // Renditions are rebuilt in place under a stable URL, so the response has
    // to carry a validator or a client keeps showing the old picture: with no
    // ETag, no Last-Modified and no Cache-Control the browser caches
    // heuristically and has nothing to revalidate against. `no-cache` still
    // caches, it just always asks first, which is a 304 in the common case.
    const etag = `"${file.size}-${Math.floor(file.lastModified)}"`;
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

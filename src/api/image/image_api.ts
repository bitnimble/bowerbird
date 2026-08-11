import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { getOriginalPath, getRenditionPath } from '../../utils/paths';
import { rawMediaType } from '../../utils/scan';
import { readEmbeddedJpeg } from '../../services/processing/raw_decoder';
import { prepareEditAsync } from '../../services/processing/rawshim_edit';
import { transcodeJpeg } from '../../services/processing/rawshim_job';
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

const JPEG_QUALITY = 92;

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
    this.routes = app;
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
    // nothing about the disk, so a file that has been moved or unplugged reaches LibRaw as a
    // path that is not there - and comes back as a 500 quoting the server's own absolute
    // path, where every sibling route here answers 404. The reader's own library is not a
    // server error, and where it lives is not theirs to be told.
    const original = getOriginalPath(library, photo.file_path);
    if (!(await Bun.file(original).exists())) {
      throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);
    }

    const settings = this.settings.get();
    // Awaited, not called: the open is seconds of LibRaw, and every other request this
    // server answers comes off the same thread. It runs on one the native side owns and
    // reports back through a callback (`rawshim_edit.ts`), so a reader opening the editor no
    // longer stops the grid loading for anybody, themselves included.
    const prepared = await prepareEditAsync({
      rawFilePath: original,
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

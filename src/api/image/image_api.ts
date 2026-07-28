import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import { getHdrPath, getOriginalPath, getRenditionPath } from '../../utils/paths';
import { readEmbeddedJpeg } from '../../services/processing/raw_decoder';
import { decodeFile, encodeJpeg, freeImage } from '../../services/processing/rawshim_ops';
import { contentTypeFor, isHdrMedium, isHdrVariant } from '../../services/processing/hdr_media';
import { isRendition, renditionContentType } from '../../services/processing/renditions';
import type { BasicPhoto } from '../../services/photos/photos_repository';
import type { PhotosService } from '../../services/photos/photos_service';

// Where a variant's bytes live, given the photo it belongs to. Passing this in
// keeps `serve` about HTTP: adding a variant is a route, not another branch in
// a path-resolving conditional.
//
// A BasicPhoto, not a PhotoDetail: serving bytes needs an id, a library and a
// file path, and asking for the detail payload put a second query and a stat per
// rendition on every thumbnail in the grid (§8.2 `locate`).
type PathFor = (library: Library, photo: BasicPhoto) => string;

const JPEG_QUALITY = 92;

// The viewer reports the weight of the rendition it is showing, and reads it off
// the response it already received rather than asking for a number the server
// would have to compute a second time (the camera's JPEG has no file on disk to
// stat, so its size is only known by extracting it, which is what serving it
// does anyway). Resource Timing hides body sizes cross-origin without this, and
// the app and the API are different origins in development.
const TIMING_ALLOW_ORIGIN = { 'Timing-Allow-Origin': '*' };

// Every stored rendition is AVIF now (§10.2).
const AVIF = 'image/avif';

// Streams straight from disk via Bun.file (no buffering); Bun.serve applies Range
// handling to the BunFile body for 206 partial content (DESIGN §13.5).
export class ImageApi {
  readonly routes: Hono;

  constructor(private readonly photos: PhotosService) {
    const app = new Hono();
    // One route for every stored rendition, named rather than spelled out per
    // size: `grid`, `full`, `max`, optionally `/video` for the one-frame AV1 twin
    // an HDR rendition carries for Firefox (§10.7). Dynamic range is not in the
    // URL - the library decides it, and a client guessing would ask for a file
    // that was never built.
    app.get('/:photoId/renditions/:rendition/:video?', (c) => {
      const rendition = c.req.param('rendition') ?? '';
      const suffix = c.req.param('video');
      if (!isRendition(rendition)) throw new AppError('NOT_FOUND', `unknown rendition: ${rendition}`);
      if (suffix != null && suffix !== 'video') throw new AppError('NOT_FOUND', `unknown rendition form: ${suffix}`);
      const video = suffix === 'video';
      return this.serve(c, renditionContentType(video), (lib, photo) =>
        getRenditionPath(lib, photo.id, rendition, lib.preview_hdr, video),
      );
    });
    // Served as the camera wrote it, never resized or transcoded into a rendition
    // of its own (§10.2). The RAW itself goes the same way.
    app.get('/:photoId/embedded.jpg', (c) => this.serveEmbedded(c));
    app.get('/:photoId/original.arw', (c) => this.serve(c, 'image/x-sony-arw', (lib, photo) => getOriginalPath(lib, photo.file_path)));
    app.get('/:photoId/full.jpg', (c) => this.serveJpeg(c));
    // HDR renditions: an AVIF still and a one-frame video, one per transfer,
    // each with an SDR reference (§10.7).
    app.get('/:photoId/hdr/:medium/:variant', (c) => {
      const medium = c.req.param('medium') ?? '';
      const variant = c.req.param('variant') ?? '';
      if (!isHdrMedium(medium)) throw new AppError('NOT_FOUND', `unknown HDR medium: ${medium}`);
      if (!isHdrVariant(variant)) throw new AppError('NOT_FOUND', `unknown HDR variant: ${variant}`);
      return this.serve(c, contentTypeFor(medium), (lib, photo) => getHdrPath(lib, photo.id, medium, variant));
    });
    this.routes = app;
  }

  // The camera's own JPEG, lifted out of the RAW and handed over unchanged. No
  // demosaic and nothing cached: extraction is a header read plus a copy, which
  // is cheaper than the disk a fourth derivative per photo would cost.
  private async serveEmbedded(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);

    const jpeg = readEmbeddedJpeg(getOriginalPath(library, photo.file_path));
    if (jpeg == null) throw new AppError('NOT_FOUND', `this file has no embedded JPEG preview: ${photoId}`);
    return new Response(new Uint8Array(jpeg), {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache', ...TIMING_ALLOW_ORIGIN },
    });
  }

  // A JPEG of the full-size rendition, transcoded on request. Nothing is stored:
  // a download is occasional, and a third derivative per photo on disk would cost
  // more than the transcode does. Downloading the RAW is the other route.
  private async serveJpeg(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);

    const file = Bun.file(getRenditionPath(library, photo.id, 'full', library.preview_hdr));
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    // Decoded from the path: the rendition's bytes have no business on this side, and
    // only the JPEG does - because that is what goes into the response.
    const rendition = decodeFile(getRenditionPath(library, photo.id, 'full', library.preview_hdr));
    let jpeg: Buffer;
    try {
      jpeg = encodeJpeg(rendition, 0, JPEG_QUALITY);
    } finally {
      freeImage(rendition);
    }
    const name = (photo.file_path.split('/').pop() ?? photo.id).replace(/\.[^.]+$/, '');
    return new Response(new Uint8Array(jpeg), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': `attachment; filename="${name}.jpg"`,
        'Cache-Control': 'no-cache',
      },
    });
  }

  // 404s go through AppError (not c.notFound()) so every not-available response
  // shares the standard JSON envelope. this.photos.locate already throws NOT_FOUND.
  //
  // Soft-deleted photos are served, not hidden: the Bin is a browsable view that
  // a user restores from, and it is unusable if every frame in it is a grey box.
  // The row and both files still exist, so there is nothing to withhold.
  private async serve(c: Context, contentType: string, pathFor: PathFor): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const { photo, library } = this.photos.locate(photoId);

    const file = Bun.file(pathFor(library, photo));
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    // Thumbnails are regenerated in place under a stable URL, so the response has
    // to carry a validator or a client keeps showing the old picture: with no
    // ETag, no Last-Modified and no Cache-Control the browser caches
    // heuristically and has nothing to revalidate against. `no-cache` still
    // caches, it just always asks first, which is a 304 in the common case.
    const etag = `"${file.size}-${Math.floor(file.lastModified)}"`;
    const headers = {
      'Content-Type': contentType,
      // Bun.serve answers Range requests against a BunFile body but doesn't
      // advertise it; without this a client can't know it may seek a 25MB RAW.
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...TIMING_ALLOW_ORIGIN,
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });

    return new Response(file, { headers });
  }
}

import { Hono } from 'hono';
import type { Context } from 'hono';
import sharp from 'sharp';
import { AppError } from '../../errors';
import type { Library } from '../../schemas/libraries';
import type { PhotoDetail } from '../../schemas/photos';
import {
  getFullThumbnailPath,
  getHdrVideoPath,
  getLosslessPath,
  getOriginalPath,
  getSmallThumbnailPath,
} from '../../utils/paths';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import { isHdrVariant } from '../../services/processing/hdr_video';
import type { PhotosService } from '../../services/photos/photos_service';

// Where a variant's bytes live, given the photo it belongs to. Passing this in
// keeps `serve` about HTTP: adding a variant is a route, not another branch in
// a path-resolving conditional.
type PathFor = (library: Library, photo: PhotoDetail) => string;

const JPEG_QUALITY = 92;

// Streams straight from disk via Bun.file (no buffering); Bun.serve applies Range
// handling to the BunFile body for 206 partial content (DESIGN §13.5).
export class ImageApi {
  readonly routes: Hono;

  constructor(
    private readonly photos: PhotosService,
    private readonly libraries: LibrariesService,
  ) {
    const app = new Hono();
    app.get('/:photoId/small.webp', (c) => this.serve(c, 'image/webp', (lib, photo) => getSmallThumbnailPath(lib, photo.id)));
    app.get('/:photoId/full.webp', (c) => this.serve(c, 'image/webp', (lib, photo) => getFullThumbnailPath(lib, photo.id)));
    app.get('/:photoId/original.arw', (c) => this.serve(c, 'image/x-sony-arw', (lib, photo) => getOriginalPath(lib, photo.file_path)));
    app.get('/:photoId/full.jpg', (c) => this.serveJpeg(c));
    // Browsers that decode JPEG XL take this directly; the rest go through the
    // client's wasm decoder (§10.5).
    app.get('/:photoId/lossless.jxl', (c) => this.serve(c, 'image/jxl', (lib, photo) => getLosslessPath(lib, photo.id)));
    // One-frame HDR stills, one per transfer, plus an SDR reference (§10.7).
    app.get('/:photoId/hdr/:variant', (c) => {
      const variant = c.req.param('variant');
      if (!isHdrVariant(variant)) throw new AppError('NOT_FOUND', `unknown HDR variant: ${variant}`);
      return this.serve(c, 'video/mp4', (lib, photo) => getHdrVideoPath(lib, photo.id, variant));
    });
    this.routes = app;
  }

  // A JPEG of the full-size thumbnail, transcoded on request. Nothing is stored:
  // a download is occasional, and a third derivative per photo on disk would cost
  // more than the transcode does. Downloading the RAW is the other route.
  private async serveJpeg(c: Context): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const photo = this.photos.get(photoId);
    const library = this.libraries.get(photo.library_id);

    const file = Bun.file(getFullThumbnailPath(library, photo.id));
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    const jpeg = await sharp(await file.arrayBuffer()).jpeg({ quality: JPEG_QUALITY }).toBuffer();
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
  // shares the standard JSON envelope. this.photos.get already throws NOT_FOUND.
  //
  // Soft-deleted photos are served, not hidden: the Bin is a browsable view that
  // a user restores from, and it is unusable if every frame in it is a grey box.
  // The row and both files still exist, so there is nothing to withhold.
  private async serve(c: Context, contentType: string, pathFor: PathFor): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const photo = this.photos.get(photoId);

    const library = this.libraries.get(photo.library_id);
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
    };
    if (c.req.header('if-none-match') === etag) return new Response(null, { status: 304, headers });

    return new Response(file, { headers });
  }
}

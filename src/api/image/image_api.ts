import { Hono } from 'hono';
import type { Context } from 'hono';
import sharp from 'sharp';
import { AppError } from '../../errors';
import { getFullThumbnailPath, getLosslessPath, getOriginalPath, getSmallThumbnailPath } from '../../utils/paths';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { PhotosService } from '../../services/photos/photos_service';

type Kind = 'small' | 'full' | 'original' | 'lossless';

const CONTENT_TYPE: Record<Kind, string> = {
  small: 'image/webp',
  full: 'image/webp',
  original: 'image/x-sony-arw',
  // No browser decodes JXL natively yet; the client carries a wasm decoder and
  // transcodes for display (§10.5).
  lossless: 'image/jxl',
};

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
    app.get('/:photoId/small.webp', (c) => this.serve(c, 'small'));
    app.get('/:photoId/full.webp', (c) => this.serve(c, 'full'));
    app.get('/:photoId/original.arw', (c) => this.serve(c, 'original'));
    app.get('/:photoId/full.jpg', (c) => this.serveJpeg(c));
    app.get('/:photoId/lossless.jxl', (c) => this.serve(c, 'lossless'));
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
  private async serve(c: Context, kind: Kind): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    const photo = this.photos.get(photoId);

    const library = this.libraries.get(photo.library_id);
    const filePath =
      kind === 'small'
        ? getSmallThumbnailPath(library, photo.id)
        : kind === 'full'
          ? getFullThumbnailPath(library, photo.id)
          : kind === 'lossless'
            ? getLosslessPath(library, photo.id)
            : getOriginalPath(library, photo.file_path);

    const file = Bun.file(filePath);
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    // Thumbnails are regenerated in place under a stable URL, so the response has
    // to carry a validator or a client keeps showing the old picture: with no
    // ETag, no Last-Modified and no Cache-Control the browser caches
    // heuristically and has nothing to revalidate against. `no-cache` still
    // caches, it just always asks first, which is a 304 in the common case.
    const etag = `"${file.size}-${Math.floor(file.lastModified)}"`;
    const headers = {
      'Content-Type': CONTENT_TYPE[kind],
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

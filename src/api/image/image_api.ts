import { Hono } from 'hono';
import type { Context } from 'hono';
import { AppError } from '../../errors';
import { getFullThumbnailPath, getOriginalPath, getSmallThumbnailPath } from '../../utils/paths';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { PhotosService } from '../../services/photos/photos_service';

type Kind = 'small' | 'full' | 'original';

const CONTENT_TYPE: Record<Kind, string> = {
  small: 'image/webp',
  full: 'image/webp',
  original: 'image/x-sony-arw',
};

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
    this.routes = app;
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
          : getOriginalPath(library, photo.file_path);

    const file = Bun.file(filePath);
    if (!(await file.exists())) throw new AppError('NOT_FOUND', `image not found on disk: ${photoId}`);

    // Bun.serve answers Range requests against a BunFile body but doesn't advertise
    // it; without this header a client has no way to know it can seek a 25MB RAW.
    return new Response(file, {
      headers: { 'Content-Type': CONTENT_TYPE[kind], 'Accept-Ranges': 'bytes' },
    });
  }
}

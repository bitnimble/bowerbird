import { Hono } from 'hono';
import type { Context } from 'hono';
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

  private async serve(c: Context, kind: Kind): Promise<Response> {
    const photoId = c.req.param('photoId');
    if (!photoId) return c.notFound();
    const photo = this.photos.get(photoId);
    if (photo.is_deleted) return c.notFound();

    const library = this.libraries.get(photo.library_id);
    const filePath =
      kind === 'small'
        ? getSmallThumbnailPath(library, photo.id)
        : kind === 'full'
          ? getFullThumbnailPath(library, photo.id)
          : getOriginalPath(library, photo.file_path);

    const file = Bun.file(filePath);
    if (!(await file.exists())) return c.notFound();

    return new Response(file, { headers: { 'Content-Type': CONTENT_TYPE[kind] } });
  }
}

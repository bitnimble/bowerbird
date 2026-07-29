import { Hono } from 'hono';
import { DeletePhotosRequestSchema, PhotoListQuerySchema, PhotoTargetSchema, UpdatePhotoRequestSchema } from '../../schemas/photos';
import { AppError } from '../../errors';
import { isRendition } from '../../services/processing/renditions';
import type { PhotosService } from '../../services/photos/photos_service';
import type { ProcessingService } from '../../services/processing/processing_service';

// Routes are registered relative to the /api mount (index.ts). Both the
// library-scoped list paths and the flat /photos/:id paths live here since they
// are all served by PhotosService (DESIGN §13.2).
export class PhotosApi {
  readonly routes: Hono;

  constructor(
    private readonly service: PhotosService,
    private readonly processing: ProcessingService,
  ) {
    const app = new Hono();

    // The same query as any other listing, not just pagination: a client acting
    // on a selection made here states the filters it was viewing under
    // (§18.3.3), so a route that silently dropped them would resolve a different
    // set of photos than the one on screen.
    app.get('/libraries/:libraryId/photos/missing', (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(this.service.listMissing(c.req.param('libraryId'), query));
    });

    app.get('/libraries/:libraryId/photos', (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(this.service.listByLibrary(c.req.param('libraryId'), query));
    });

    // Answers with a count, not with the ids. The undo restores by the batch id
    // the client stamped the request with (§12.3): the selection those photos
    // came from resolves to different ones now that they have left the
    // collection, and handing back a million ids would be a 36MB response the
    // client only needs in order to say "that one bin".
    app.post('/photos/delete', async (c) => {
      const body: unknown = await c.req.json();
      const { batch } = DeletePhotosRequestSchema.parse(body);
      const photoIds = this.target(body);
      await this.service.delete(photoIds, batch);
      return c.json({ deleted: photoIds.length });
    });

    app.post('/photos/restore', async (c) => {
      await this.service.restore(this.target(await c.req.json()));
      return c.body(null, 204);
    });

    // Rebuilds grid tiles, and nothing else: the photo view's renditions are built
    // and rebuilt on their own (§10.3). Separate from PATCH because it is work to
    // schedule, not a field to set, and it applies to a whole selection.
    app.post('/photos/rebuild-tiles', async (c) => {
      return c.json({ queued: await this.processing.rebuildTiles(this.target(await c.req.json())) });
    });

    // Re-reads the RAW headers. Sync only re-opens a file whose stat changed, so
    // photos catalogued before a field existed need an explicit nudge.
    app.post('/photos/refresh-metadata', async (c) => {
      return c.json({ updated: await this.service.refreshMetadata(this.target(await c.req.json())) });
    });

    // Ensures one rendition exists. Returns at once when it is already cached,
    // which is the common case after the first look. The max-resolution one is
    // slow and large by design, so this is one photo at a time and only on ask.
    app.post('/photos/:id/renditions/:rendition', async (c) => {
      const rendition = c.req.param('rendition') ?? '';
      if (!isRendition(rendition) || rendition === 'grid') {
        throw new AppError('NOT_FOUND', `not a rendition the viewer can build: ${rendition}`);
      }
      // `force` drops the cached copy first, for a viewer comparing settings that
      // changed since it was built - the file is the cache, so nothing else would
      // ever rebuild it.
      const force = c.req.query('force') === 'true';
      await this.service.buildRendition(c.req.param('id'), rendition, force);
      return c.body(null, 204);
    });

    // Builds the HDR stills (§10.7). Diagnostic: they exist to be opened on a
    // real HDR display, since nothing in a page can observe HDR output.
    app.post('/photos/:id/hdr', async (c) => {
      await this.service.buildHdr(c.req.param('id'));
      return c.body(null, 204);
    });

    app.get('/photos/:id', (c) => c.json(this.service.get(c.req.param('id'))));

    app.patch('/photos/:id', async (c) => {
      const body = UpdatePhotoRequestSchema.parse(await c.req.json());
      return c.json(this.service.update(c.req.param('id'), body));
    });

    this.routes = app;
  }

  // Every bulk route takes the same two shapes: the ids, or the positions to
  // read them from.
  private target(body: unknown): string[] {
    return this.service.resolve(PhotoTargetSchema.parse(body));
  }
}

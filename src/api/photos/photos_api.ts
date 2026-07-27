import { Hono } from 'hono';
import { PaginationSchema, PhotoIdListSchema } from '../../schemas/common';
import { PhotoListQuerySchema, PreviewRequestSchema, ReprocessRequestSchema, UpdatePhotoRequestSchema } from '../../schemas/photos';
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

    app.get('/libraries/:libraryId/photos/missing', (c) => {
      const pagination = PaginationSchema.parse(c.req.query());
      return c.json(this.service.listMissing(c.req.param('libraryId'), pagination));
    });

    app.get('/libraries/:libraryId/photos', (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(this.service.listByLibrary(c.req.param('libraryId'), query));
    });

    app.post('/photos/delete', async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      await this.service.delete(photo_ids);
      return c.body(null, 204);
    });

    app.post('/photos/restore', async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      await this.service.restore(photo_ids);
      return c.body(null, 204);
    });

    // Rebuilds thumbnails from a chosen source. Separate from PATCH because it is
    // work to schedule, not a field to set, and it applies to a whole selection.
    app.post('/photos/reprocess', async (c) => {
      const { photo_ids, source } = ReprocessRequestSchema.parse(await c.req.json());
      return c.json({ queued: await this.processing.reprocess(photo_ids, source) });
    });

    // Re-reads the RAW headers. Sync only re-opens a file whose stat changed, so
    // photos catalogued before a field existed need an explicit nudge.
    app.post('/photos/refresh-metadata', async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      return c.json({ updated: await this.service.refreshMetadata(photo_ids) });
    });

    // Ensures a full-size preview from one source exists. Returns at once when it
    // is already cached, which is the common case after the first look.
    app.post('/photos/:id/preview', async (c) => {
      const { source } = PreviewRequestSchema.parse(await c.req.json());
      await this.service.buildPreview(c.req.param('id'), source);
      return c.body(null, 204);
    });

    // Builds the full-resolution lossless render. Slow and large by design, so it
    // is one photo at a time and only when asked for.
    app.post('/photos/:id/lossless', async (c) => {
      await this.service.buildLossless(c.req.param('id'));
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
}

import { Hono } from 'hono';
import { PaginationSchema, PhotoIdListSchema } from '../../schemas/common';
import { PhotoListQuerySchema, UpdatePhotoRequestSchema } from '../../schemas/photos';
import type { PhotosService } from '../../services/photos/photos_service';

// Routes are registered relative to the /api mount (index.ts). Both the
// library-scoped list paths and the flat /photos/:id paths live here since they
// are all served by PhotosService (DESIGN §13.2).
export class PhotosApi {
  readonly routes: Hono;

  constructor(private readonly service: PhotosService) {
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

    app.get('/photos/:id', (c) => c.json(this.service.get(c.req.param('id'))));

    app.patch('/photos/:id', async (c) => {
      const body = UpdatePhotoRequestSchema.parse(await c.req.json());
      return c.json(this.service.update(c.req.param('id'), body));
    });

    this.routes = app;
  }
}

import { Hono } from 'hono';
import { PhotoIdListSchema, ScopedListQuerySchema } from '../../schemas/common';
import { CreateShootRequestSchema, UpdateShootRequestSchema } from '../../schemas/shoots';
import type { PhotosService } from '../../services/photos/photos_service';
import type { ShootsService } from '../../services/shoots/shoots_service';

export class ShootsApi {
  readonly routes: Hono;

  constructor(
    private readonly shoots: ShootsService,
    private readonly photos: PhotosService,
  ) {
    const app = new Hono();

    app.post('/shoots', async (c) => c.json(await this.shoots.create(CreateShootRequestSchema.parse(await c.req.json())), 201));

    app.get('/libraries/:libraryId/shoots', (c) => c.json(this.shoots.list(c.req.param('libraryId'))));

    app.get('/shoots/:id', (c) => c.json(this.shoots.get(c.req.param('id'))));

    app.patch('/shoots/:id', async (c) => c.json(await this.shoots.update(c.req.param('id'), UpdateShootRequestSchema.parse(await c.req.json()))));

    app.delete('/shoots/:id', (c) => {
      this.shoots.delete(c.req.param('id'));
      return c.body(null, 204);
    });

    app.post('/shoots/:id/photos', async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      await this.shoots.addPhotos(c.req.param('id'), photo_ids);
      return c.body(null, 204);
    });

    app.delete('/shoots/:id/photos', async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      await this.shoots.removePhotos(c.req.param('id'), photo_ids);
      return c.body(null, 204);
    });

    app.get('/shoots/:id/photos', (c) => {
      const query = ScopedListQuerySchema.parse(c.req.query());
      return c.json(this.photos.listByShoot(c.req.param('id'), query));
    });

    this.routes = app;
  }
}

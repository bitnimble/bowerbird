import { Hono } from 'hono';
import { PhotoIdListSchema } from '../../schemas/common';
import { PhotoTargetSchema } from '../../schemas/photos';
import { CreateStackRequestSchema, StackPhotosQuerySchema } from '../../schemas/stacks';
import type { PhotosService } from '../../services/photos/photos_service';
import type { StacksService } from '../../services/stacks/stacks_service';

export class StacksApi {
  readonly routes: Hono;

  constructor(
    private readonly stacks: StacksService,
    private readonly photos: PhotosService,
  ) {
    const app = new Hono();

    // Ids, or the positions to read them from, as every bulk route takes
    // (§18.3.3). A selected stack becomes its members inside `resolve`, so a
    // client that only ever held positions can still ask for a stack of photos
    // it has never been told the ids of.
    app.post('/', async (c) => {
      const body = await c.req.json();
      const parsed = CreateStackRequestSchema.safeParse(body);
      const photoIds = parsed.success ? parsed.data.photo_ids : this.photos.resolve(PhotoTargetSchema.parse(body));
      return c.json(this.stacks.create(photoIds), 201);
    });

    app.get('/:id', (c) => c.json(this.stacks.get(c.req.param('id'))));

    // Every member, so a shoot can show the ones that are elsewhere behind an
    // overlay; `album_id` narrows to what that album holds, because an album is
    // strict about its contents (§19.5.3).
    app.get('/:id/photos', (c) => {
      const query = StackPhotosQuerySchema.parse(c.req.query());
      return c.json(this.stacks.photosOf(c.req.param('id'), { albumId: query.album_id, deleted: query.deleted }));
    });

    app.delete('/:id', (c) => {
      this.stacks.unstack(c.req.param('id'));
      return c.body(null, 204);
    });

    app.post('/:id/remove', async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      this.stacks.removePhotos(c.req.param('id'), photo_ids);
      return c.body(null, 204);
    });

    this.routes = app;
  }
}

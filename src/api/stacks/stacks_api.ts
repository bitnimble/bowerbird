import { Hono } from 'hono';
import { PhotoIdListSchema } from '../../schemas/common';
import { PhotoSummaryListSchema, PhotoTargetSchema } from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import { CreateStackRequestSchema, StackPhotosQuerySchema, StackSchema, UnstackedCountSchema } from '../../schemas/stacks';
import { respond } from '../respond';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import type { StacksService } from '../../services/stacks/stacks_service';

export class StacksApi {
  readonly routes: Hono;

  constructor(
    private readonly stacks: StacksService,
    private readonly photos: PhotoReadService,
  ) {
    const app = new Hono();

    // Ids, or the positions to read them from, as every bulk route takes
    // (§18.3.3). A selected stack becomes its members inside `resolve`, so a
    // client that only ever held positions can still ask for a stack of photos
    // it has never been told the ids of.
    app.post(route(), async (c) => {
      const body: unknown = await c.req.json();
      const parsed = CreateStackRequestSchema.safeParse(body);
      const photoIds = parsed.success ? parsed.data.photo_ids : this.photos.resolve(PhotoTargetSchema.parse(body));
      return c.json(respond(StackSchema, this.stacks.create(photoIds)), 201);
    });

    // Whatever stacks a selection touches, taken apart. Literal path so it cannot
    // be read as `/:id`, and a POST because it carries the same target body the
    // create above does.
    app.post(route(PathSegment.unstack()), async (c) => {
      const photoIds = this.photos.resolve(PhotoTargetSchema.parse(await c.req.json()));
      return c.json(respond(UnstackedCountSchema, { unstacked: this.stacks.unstackAllOf(photoIds) }));
    });

    app.get(route(PathSegment.param('id')), (c) => c.json(respond(StackSchema, this.stacks.get(c.req.param('id')))));

    // Every member, so a shoot can show the ones that are elsewhere behind an
    // overlay; `album_id` narrows to what that album holds, because an album is
    // strict about its contents (§19.5.3).
    app.get(route(PathSegment.param('id'), PathSegment.photos()), (c) => {
      const query = StackPhotosQuerySchema.parse(c.req.query());
      return c.json(
        respond(
          PhotoSummaryListSchema,
          this.stacks.photosOf(c.req.param('id'), {
            ordering: query.ordering,
            albumId: query.album_id,
            shootId: query.shoot_id,
            deleted: query.deleted,
          }),
        ),
      );
    });

    app.post(route(PathSegment.param('id'), PathSegment.remove()), async (c) => {
      const { photo_ids } = PhotoIdListSchema.parse(await c.req.json());
      this.stacks.removePhotos(c.req.param('id'), photo_ids);
      return c.body(null, 204);
    });

    this.routes = app;
  }
}

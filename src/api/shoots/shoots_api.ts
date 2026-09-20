import { Hono } from 'hono';
import { PhotoListQuerySchema, PhotoListResponseSchema, PhotoTargetSchema } from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import {
  CreateShootRequestSchema,
  DeleteShootQuerySchema,
  HiddenShootsQuerySchema,
  ShootListSchema,
  ShootRemovalSchema,
  ShootSchema,
  UpdateShootRequestSchema,
} from '../../schemas/shoots';
import { respond } from '../respond';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import type { ShootsService } from '../../services/shoots/shoots_service';

export class ShootsApi {
  readonly routes: Hono;

  constructor(
    private readonly shoots: ShootsService,
    private readonly photos: PhotoReadService,
  ) {
    const app = new Hono();

    app.post(route(PathSegment.shoots()), async (c) =>
      c.json(respond(ShootSchema, await this.shoots.create(CreateShootRequestSchema.parse(await c.req.json()))), 201),
    );

    app.get(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.shoots()), (c) => {
      const { include_hidden } = HiddenShootsQuerySchema.parse(c.req.query());
      return c.json(respond(ShootListSchema, this.shoots.list(c.req.param('libraryId'), include_hidden)));
    });

    app.get(route(PathSegment.shoots(), PathSegment.param('id')), (c) => c.json(respond(ShootSchema, this.shoots.get(c.req.param('id')))));

    app.patch(route(PathSegment.shoots(), PathSegment.param('id')), async (c) =>
      c.json(respond(ShootSchema, await this.shoots.update(c.req.param('id'), UpdateShootRequestSchema.parse(await c.req.json())))),
    );

    // Read by the delete dialog before it offers the irreversible half.
    app.get(route(PathSegment.shoots(), PathSegment.param('id'), PathSegment.removal()), (c) =>
      c.json(respond(ShootRemovalSchema, { photos: this.shoots.removalCount(c.req.param('id')) })),
    );

    app.delete(route(PathSegment.shoots(), PathSegment.param('id')), async (c) => {
      const { photos } = DeleteShootQuerySchema.parse(c.req.query());
      await this.shoots.delete(c.req.param('id'), photos);
      return c.body(null, 204);
    });

    // Ids, or the positions to read them from - the same two shapes every bulk
    // route takes (§18.3.3).
    app.post(route(PathSegment.shoots(), PathSegment.param('id'), PathSegment.photos()), async (c) => {
      await this.shoots.addPhotos(c.req.param('id'), this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())));
      return c.body(null, 204);
    });

    app.delete(route(PathSegment.shoots(), PathSegment.param('id'), PathSegment.photos()), async (c) => {
      await this.shoots.removePhotos(c.req.param('id'), this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())));
      return c.body(null, 204);
    });

    app.get(route(PathSegment.shoots(), PathSegment.param('id'), PathSegment.photos()), (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(respond(PhotoListResponseSchema, this.photos.listByShoot(c.req.param('id'), query)));
    });

    this.routes = app;
  }
}

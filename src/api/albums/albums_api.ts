import { Hono } from 'hono';
import { AlbumListSchema, AlbumSchema, CreateAlbumRequestSchema, UpdateAlbumRequestSchema } from '../../schemas/albums';
import { PhotoListQuerySchema, PhotoListResponseSchema, PhotoTargetSchema } from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import { respond } from '../respond';
import type { AlbumsService } from '../../services/albums/albums_service';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';

export class AlbumsApi {
  readonly routes: Hono;

  constructor(
    private readonly albums: AlbumsService,
    private readonly photos: PhotoReadService,
  ) {
    const app = new Hono();

    app.post(route(), async (c) =>
      c.json(respond(AlbumSchema, this.albums.create(CreateAlbumRequestSchema.parse(await c.req.json()))), 201),
    );

    app.get(route(), (c) => c.json(respond(AlbumListSchema, this.albums.list())));

    app.get(route(PathSegment.param('id')), (c) => c.json(respond(AlbumSchema, this.albums.get(c.req.param('id')))));

    app.patch(route(PathSegment.param('id')), async (c) =>
      c.json(respond(AlbumSchema, this.albums.update(c.req.param('id'), UpdateAlbumRequestSchema.parse(await c.req.json())))),
    );

    app.delete(route(PathSegment.param('id')), (c) => {
      this.albums.delete(c.req.param('id'));
      return c.body(null, 204);
    });

    // Ids, or the positions to read them from - the same two shapes every bulk
    // route takes (§18.3.3).
    app.post(route(PathSegment.param('id'), PathSegment.photos()), async (c) => {
      this.albums.addPhotos(c.req.param('id'), this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())));
      return c.body(null, 204);
    });

    app.delete(route(PathSegment.param('id'), PathSegment.photos()), async (c) => {
      this.albums.removePhotos(c.req.param('id'), this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())));
      return c.body(null, 204);
    });

    app.get(route(PathSegment.param('id'), PathSegment.photos()), (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(respond(PhotoListResponseSchema, this.photos.listByAlbum(c.req.param('id'), query)));
    });

    this.routes = app;
  }
}

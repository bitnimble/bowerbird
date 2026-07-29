import { Hono } from 'hono';
import { CreateAlbumRequestSchema, UpdateAlbumRequestSchema } from '../../schemas/albums';
import { PhotoListQuerySchema, PhotoTargetSchema } from '../../schemas/photos';
import type { AlbumsService } from '../../services/albums/albums_service';
import type { PhotosService } from '../../services/photos/photos_service';

export class AlbumsApi {
  readonly routes: Hono;

  constructor(
    private readonly albums: AlbumsService,
    private readonly photos: PhotosService,
  ) {
    const app = new Hono();

    app.post('/', async (c) => c.json(this.albums.create(CreateAlbumRequestSchema.parse(await c.req.json())), 201));

    app.get('/', (c) => c.json(this.albums.list()));

    app.get('/:id', (c) => c.json(this.albums.get(c.req.param('id'))));

    app.patch('/:id', async (c) => c.json(this.albums.update(c.req.param('id'), UpdateAlbumRequestSchema.parse(await c.req.json()))));

    app.delete('/:id', (c) => {
      this.albums.delete(c.req.param('id'));
      return c.body(null, 204);
    });

    // Ids, or the positions to read them from - the same two shapes every bulk
    // route takes (§18.3.3).
    app.post('/:id/photos', async (c) => {
      this.albums.addPhotos(c.req.param('id'), this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())));
      return c.body(null, 204);
    });

    app.delete('/:id/photos', async (c) => {
      this.albums.removePhotos(c.req.param('id'), this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())));
      return c.body(null, 204);
    });

    app.get('/:id/photos', (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(this.photos.listByAlbum(c.req.param('id'), query));
    });

    this.routes = app;
  }
}

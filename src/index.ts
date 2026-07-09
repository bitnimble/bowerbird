import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { createDatabase } from './db/connection';
import { AppError } from './errors';
import { LibrariesApi } from './api/libraries/libraries_api';
import { LibrariesService } from './services/libraries/libraries_service';
import { LibrariesRepository } from './services/libraries/libraries_repository';
import { PhotosApi } from './api/photos/photos_api';
import { PhotosService } from './services/photos/photos_service';
import { PhotosRepository } from './services/photos/photos_repository';
import { ShootsRepository } from './services/shoots/shoots_repository';
import { AlbumsApi } from './api/albums/albums_api';
import { AlbumsService } from './services/albums/albums_service';
import { AlbumsRepository } from './services/albums/albums_repository';

const DB_PATH = process.env.DB_PATH ?? './bowerbird.db';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const db = createDatabase(DB_PATH);

const librariesRepo = new LibrariesRepository(db);
const photosRepo = new PhotosRepository(db);
const shootsRepo = new ShootsRepository(db);
const albumsRepo = new AlbumsRepository(db);

const librariesService = new LibrariesService(librariesRepo);
const photosService = new PhotosService(photosRepo, albumsRepo, shootsRepo, librariesRepo);
const albumsService = new AlbumsService(albumsRepo);

const librariesApi = new LibrariesApi(librariesService);
const photosApi = new PhotosApi(photosService);
const albumsApi = new AlbumsApi(albumsService, photosService);

const app = new Hono();
app.route('/api/libraries', librariesApi.routes);
app.route('/api', photosApi.routes);
app.route('/api/albums', albumsApi.routes);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.issues } }, 400);
  }
  if (err instanceof SyntaxError) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
  }
  console.error(err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } }, 500);
});

export default { port: PORT, hostname: HOST, fetch: app.fetch };

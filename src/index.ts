import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { createDatabase } from './db/connection';
import { AppError } from './errors';
import { LibrariesApi } from './api/libraries/libraries_api';
import { LibrariesService } from './services/libraries/libraries_service';
import { LibrariesRepository } from './services/libraries/libraries_repository';

const DB_PATH = process.env.DB_PATH ?? './bowerbird.db';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const db = createDatabase(DB_PATH);

const librariesRepo = new LibrariesRepository(db);
const librariesService = new LibrariesService(librariesRepo);
const librariesApi = new LibrariesApi(librariesService);

const app = new Hono();
app.route('/api/libraries', librariesApi.routes);

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

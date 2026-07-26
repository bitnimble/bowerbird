import { Hono } from 'hono';
import { CreateLibraryRequestSchema, UpdateLibraryRequestSchema } from '../../schemas/libraries';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { SyncService } from '../../services/sync/sync_service';

export class LibrariesApi {
  readonly routes: Hono;

  constructor(
    private readonly service: LibrariesService,
    private readonly sync: SyncService,
  ) {
    const app = new Hono();

    app.post('/', async (c) => {
      const body = CreateLibraryRequestSchema.parse(await c.req.json());
      return c.json(await this.service.create(body), 201);
    });

    app.get('/', (c) => c.json(this.service.list()));

    app.post('/:id/sync', async (c) => c.json(await this.sync.syncLibrary(c.req.param('id'))));

    app.get('/:id/sync/status', (c) => c.json(this.sync.getSyncStatus(c.req.param('id'))));

    app.get('/:id', (c) => c.json(this.service.get(c.req.param('id'))));

    app.patch('/:id', async (c) => {
      const body = UpdateLibraryRequestSchema.parse(await c.req.json());
      return c.json(this.service.update(c.req.param('id'), body));
    });

    app.delete('/:id', (c) => {
      this.service.delete(c.req.param('id'));
      return c.body(null, 204);
    });

    this.routes = app;
  }
}

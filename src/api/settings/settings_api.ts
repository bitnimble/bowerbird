import { Hono } from 'hono';
import { DEFAULT_SETTINGS, UpdateSettingsRequestSchema } from '../../schemas/settings';
import type { SettingsRepository } from '../../services/settings/settings_repository';

// No service layer: these are stored preferences with nothing to orchestrate.
export class SettingsApi {
  readonly routes: Hono;

  constructor(private readonly settings: SettingsRepository) {
    const app = new Hono();

    app.get('/', (c) => c.json(this.settings.get()));

    // What the app ships with, so a client can offer "put this back" without
    // carrying a copy of the schema's defaults. Before `/` in no sense that
    // matters here - there is no `/:key` route to shadow it.
    app.get('/defaults', (c) => c.json(DEFAULT_SETTINGS));

    app.patch('/', async (c) => {
      const body = UpdateSettingsRequestSchema.parse(await c.req.json());
      return c.json(this.settings.update(body));
    });

    this.routes = app;
  }
}

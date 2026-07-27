import { Hono } from 'hono';
import { UpdateSettingsRequestSchema } from '../../schemas/settings';
import type { SettingsRepository } from '../../services/settings/settings_repository';

// No service layer: these are stored preferences with nothing to orchestrate.
export class SettingsApi {
  readonly routes: Hono;

  constructor(private readonly settings: SettingsRepository) {
    const app = new Hono();

    app.get('/', (c) => c.json(this.settings.get()));

    app.patch('/', async (c) => {
      const body = UpdateSettingsRequestSchema.parse(await c.req.json());
      return c.json(this.settings.update(body));
    });

    this.routes = app;
  }
}

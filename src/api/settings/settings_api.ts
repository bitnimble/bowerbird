import { Hono } from 'hono';
import { PathSegment, route } from '../../schemas/route';
import { DEFAULT_SETTINGS, SettingsSchema, UpdateSettingsRequestSchema } from '../../schemas/settings';
import type { SettingsRepository } from '../../services/settings/settings_repository';
import { respond } from '../respond';

// No service layer: these are stored preferences with nothing to orchestrate.
export class SettingsApi {
  readonly routes: Hono;

  constructor(private readonly settings: SettingsRepository) {
    const app = new Hono();

    app.get(route(), (c) => c.json(respond(SettingsSchema, this.settings.get())));

    // What the app ships with, so a client can offer "put this back" without
    // carrying a copy of the schema's defaults. Before `/` in no sense that
    // matters here - there is no `/:key` route to shadow it.
    app.get(route(PathSegment.defaults()), (c) => c.json(respond(SettingsSchema, DEFAULT_SETTINGS)));

    app.patch(route(), async (c) => {
      const body = UpdateSettingsRequestSchema.parse(await c.req.json());
      return c.json(respond(SettingsSchema, this.settings.update(body)));
    });

    this.routes = app;
  }
}

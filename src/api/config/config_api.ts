import { Hono } from 'hono';
import { z } from 'zod';
import type { Config } from '../../config';
import { ThumbnailSourceSchema } from '../../schemas/photos';
import type { SettingsRepository } from '../../services/settings/settings_repository';

const UpdateSettingsSchema = z.object({
  thumbnail_source: ThumbnailSourceSchema,
});

// Two different things share this mount: `config` is fixed by the deployment
// (thumbnail encoding, so a client can state what it is rendering), `settings`
// is what the user can change from the app.
export class ConfigApi {
  readonly routes: Hono;

  constructor(config: Config, settings: SettingsRepository) {
    const app = new Hono();

    app.get('/', (c) =>
      c.json({
        thumbnails: {
          format: 'webp',
          color_space: 'sRGB',
          small: { size: config.smallThumbnailSize, quality: config.smallThumbnailQuality },
          full: { size: config.fullThumbnailSize, quality: config.fullThumbnailQuality },
        },
      }),
    );

    app.get('/settings', (c) => c.json({ thumbnail_source: settings.getThumbnailSource() }));

    // Applies to photos indexed from here on. Existing thumbnails are untouched:
    // rebuilding them is the explicit reprocess action, not a side effect of
    // changing a preference.
    app.put('/settings', async (c) => {
      const body = UpdateSettingsSchema.parse(await c.req.json());
      settings.setThumbnailSource(body.thumbnail_source);
      return c.json({ thumbnail_source: settings.getThumbnailSource() });
    });

    this.routes = app;
  }
}

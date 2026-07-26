import { Hono } from 'hono';
import type { Config } from '../../config';

// Server-side settings a client needs to describe what it is showing. The
// thumbnail box on the photo view reports the format and quality it was encoded
// at, which only the server knows.
export class ConfigApi {
  readonly routes: Hono;

  constructor(config: Config) {
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
    this.routes = app;
  }
}

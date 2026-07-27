import { Hono } from 'hono';
import type { Config } from '../../config';

// Fixed by the deployment, so a client can state what it is rendering. What the
// user can change lives on the library now (§10.2): the preview source and HDR
// are per catalogue, not per server, because one may be scanned JPEGs where the
// camera's rendering is the point and another RAWs worth demosaicing.
export class ConfigApi {
  readonly routes: Hono;

  constructor(config: Config) {
    const app = new Hono();

    app.get('/', (c) =>
      c.json({
        thumbnails: {
          format: 'avif',
          color_space: 'sRGB',
          small: { size: config.smallThumbnailSize, quality: config.smallThumbnailQuality },
          full: { size: config.fullThumbnailSize, quality: config.fullThumbnailQuality },
        },
      }),
    );

    this.routes = app;
  }
}

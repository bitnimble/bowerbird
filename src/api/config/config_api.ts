import { Hono } from 'hono';
import type { Config } from '../../config';

// Fixed by the deployment, so a client can state what it is rendering. What the
// user can change lives on the library now (§10.2): the rendition source and HDR
// are per catalogue, not per server, because one may be scanned JPEGs where the
// camera's rendering is the point and another RAWs worth demosaicing.
export class ConfigApi {
  readonly routes: Hono;

  constructor(config: Config) {
    const app = new Hono();

    app.get('/', (c) =>
      c.json({
        renditions: {
          format: 'avif',
          color_space: 'sRGB',
          grid: { size: config.gridRenditionSize, quality: config.gridRenditionQuality },
          full: { size: config.fullRenditionSize, quality: config.fullRenditionQuality },
        },
      }),
    );

    this.routes = app;
  }
}

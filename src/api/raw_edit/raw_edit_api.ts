import path from 'node:path';
import { Hono } from 'hono';

// Ships a RAW file whole, for the client-side editing spike (`/test-raw-editing`).
//
// Nothing here renders: the point of the spike is that the browser does the decode and
// the grade, so this endpoint's only job is to hand over the bytes. Which is also why
// it is not part of the image API - that one serves renditions this server produced.
//
// The path is a query parameter and is not sandboxed, for the same reason `BrowseApi`
// is not: the server binds to the operator's own machine and CORS refuses an unrelated
// origin (§15). Absolute paths only, so a relative one cannot walk out of wherever the
// process happens to be running.
export class RawEditApi {
  readonly routes: Hono;

  constructor() {
    const app = new Hono();

    app.get('/raw', async (c) => {
      const requested = c.req.query('path');
      if (requested == null || requested === '') return c.json({ error: 'path is required' }, 400);

      const resolved = path.resolve(requested);
      if (resolved !== path.normalize(requested)) {
        return c.json({ error: 'path must be absolute' }, 400);
      }

      const file = Bun.file(resolved);
      if (!(await file.exists())) return c.json({ error: `no such file: ${resolved}` }, 404);

      // Explicitly not the sniffed type: a CR3 reads as video/mp4 to some sniffers,
      // which is exactly the wrong thing for a browser to try to do with it.
      return new Response(file, {
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      });
    });

    this.routes = app;
  }
}

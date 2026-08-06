import { homedir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { browseAbsolute } from '../../utils/browse';
import { isWritable } from '../../services/libraries/libraries_service';

// Walking the server's directories, so a library can be added by finding the
// folder rather than typing its absolute path from memory. No service layer:
// there is nothing to orchestrate and nothing to store.
//
// Deliberately not sandboxed to any root. The library a photographer wants may
// be on any mount, and the API already accepts an arbitrary absolute path when
// creating one, so a jail here would block the picker without protecting
// anything. What keeps this closed is what keeps the rest of the API closed:
// it binds to the operator's own machine and CORS refuses an unrelated origin
// (§15). The per-library picker is fenced, because there a folder outside the
// root is not merely unhelpful but wrong (`GET /api/libraries/:id/browse`).
export class BrowseApi {
  readonly routes: Hono;

  constructor() {
    const app = new Hono();

    app.get('/', async (c) => {
      const requested = c.req.query('path');
      const dir = requested == null || requested === '' ? homedir() : path.resolve(requested);
      return c.json(await browseAbsolute(dir, isWritable));
    });

    this.routes = app;
  }
}

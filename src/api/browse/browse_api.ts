import { homedir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { BrowseQuerySchema, BrowseResponseSchema, CreateFolderRequestSchema } from '../../schemas/browse';
import { route } from '../../schemas/route';
import { browseAbsolute, createFolder } from '../../utils/browse';
import { isWritable } from '../../services/libraries/libraries_service';
import { respond } from '../respond';

// Walking the server's directories, so a library can be added by finding the
// folder rather than typing its absolute path from memory. No service layer:
// there is nothing to orchestrate and nothing to store.
//
// Deliberately not sandboxed to any root. The library a photographer wants may
// be on any mount, and the API already accepts an arbitrary absolute path when
// creating one, so a jail here would block the picker without protecting
// anything. What keeps this closed is what keeps the rest of the API closed:
// it binds to the operator's own machine and CORS refuses an unrelated origin
// (§15). Inside a library the question is a different one, and answered whole
// rather than a level at a time (`GET /api/libraries/:id/folders`).
export class BrowseApi {
  readonly routes: Hono;

  constructor() {
    const app = new Hono();

    app.get(route(), async (c) => {
      const { path: requested } = BrowseQuerySchema.parse(c.req.query());
      const dir = requested == null || requested === '' ? homedir() : path.resolve(requested);
      return c.json(respond(BrowseResponseSchema, await browseAbsolute(dir, isWritable)));
    });

    // A new folder inside the one being listed, answered with its own listing so the picker lands in it.
    app.post(route(), async (c) => {
      const { parent, name } = CreateFolderRequestSchema.parse(await c.req.json());
      const dir = path.join(path.resolve(parent), name);
      await createFolder(dir);
      return c.json(respond(BrowseResponseSchema, await browseAbsolute(dir, isWritable)), 201);
    });

    this.routes = app;
  }
}

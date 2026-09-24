import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../errors';
import { PrinterProfilesSchema } from '../../schemas/printer_profiles';
import { PathSegment, route } from '../../schemas/route';
import { respond } from '../respond';

const PROFILE = /\.ic[cm]$/i;

export class PrinterProfilesApi {
  readonly routes: Hono;

  constructor(dir: string) {
    const app = new Hono();
    const list = async (): Promise<string[]> => {
      const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      return names.filter((name) => PROFILE.test(name)).sort((a, b) => a.localeCompare(b));
    };

    app.get(route(), async (c) => c.json(respond(PrinterProfilesSchema, { profiles: await list() })));

    app.get(route(PathSegment.param('name')), async (c) => {
      const name = c.req.param('name');
      // Served only by a name the listing gave, so no path reaches outside the folder.
      if (!(await list()).includes(name)) throw new AppError('NOT_FOUND', `no printer profile named ${name}`);
      return new Response(Bun.file(path.join(dir, name)), { headers: { 'Content-Type': 'application/vnd.iccprofile' } });
    });

    this.routes = app;
  }
}

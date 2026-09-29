import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../errors';
import { PrinterProfilesSchema } from '../../schemas/printer_profiles';
import { PathSegment, route } from '../../schemas/route';
import { listPrinterProfiles } from '../../utils/paths';
import { respond } from '../respond';

export class PrinterProfilesApi {
  readonly routes: Hono;

  constructor(dir: string) {
    const app = new Hono();
    app.get(route(), async (c) =>
      c.json(respond(PrinterProfilesSchema, { profiles: await listPrinterProfiles(dir) })),
    );

    app.get(route(PathSegment.param('name')), async (c) => {
      const name = c.req.param('name');
      // Served only by a name the listing gave, so no path reaches outside the folder.
      if (!(await listPrinterProfiles(dir)).includes(name))
        throw new AppError('NOT_FOUND', `no printer profile named ${name}`);
      return new Response(Bun.file(path.join(dir, name)), {
        headers: { 'Content-Type': 'application/vnd.iccprofile' },
      });
    });

    this.routes = app;
  }
}

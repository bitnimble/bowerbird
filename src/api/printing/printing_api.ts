import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors';
import {
  PrinterCapabilitiesSchema,
  PrintersSchema,
  PrintJobIdSchema,
  PrintJobStateSchema,
  PrintRequestSchema,
  PrintSheetRequestSchema,
} from '../../schemas/printing';
import { PathSegment, route } from '../../schemas/route';
import type { PrintService } from '../../services/printing/print_service';
import { takeAsLongAsItTakes } from '../long_requests';
import { respond } from '../respond';

const PRINTER = PathSegment.param('printer');

export class PrintingApi {
  readonly routes: Hono;

  constructor(printing: PrintService) {
    const app = new Hono();

    app.get(route(PathSegment.printers()), async (c) =>
      c.json(respond(PrintersSchema, { printers: await printing.printers() })),
    );

    app.get(route(PathSegment.printers(), PRINTER, PathSegment.capabilities()), async (c) =>
      c.json(
        respond(PrinterCapabilitiesSchema, await printing.capabilities(c.req.param('printer'))),
      ),
    );

    app.get(
      route(PathSegment.printers(), PRINTER, PathSegment.profiles(), PathSegment.param('name')),
      async (c) =>
        new Response(
          new Uint8Array(
            await printing.printerProfile(c.req.param('printer'), c.req.param('name')),
          ),
          { headers: { 'Content-Type': 'application/vnd.iccprofile' } },
        ),
    );

    app.get(
      route(PathSegment.printers(), PRINTER, PathSegment.jobs(), PathSegment.param('jobId')),
      async (c) => {
        const jobId = z.coerce.number().int().safeParse(c.req.param('jobId'));
        if (!jobId.success) throw new AppError('VALIDATION_ERROR', 'not a print job');
        return c.json(
          respond(PrintJobStateSchema, await printing.job(c.req.param('printer'), jobId.data)),
        );
      },
    );

    app.post(route(PathSegment.jobs()), async (c) => {
      const parsed = PrintRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'not a print request');
      takeAsLongAsItTakes(c);
      return c.json(respond(PrintJobIdSchema, { jobId: await printing.submit(parsed.data) }));
    });

    app.post(route(PathSegment.sheet()), async (c) => {
      const parsed = PrintSheetRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'not a print sheet');
      takeAsLongAsItTakes(c);
      return new Response(new Uint8Array(await printing.sheet(parsed.data)), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
      });
    });

    this.routes = app;
  }
}

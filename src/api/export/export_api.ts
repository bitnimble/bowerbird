import { Hono } from 'hono';
import { AppError } from '../../errors';
import { ExportRequestSchema } from '../../schemas/export';
import {
  ExportRunsSchema,
  QueuedExportsRequestSchema,
  QueuedPhotosSchema,
  RecordExportRequestSchema,
  type ExportProgress,
} from '../../schemas/exports';
import { PathSegment, route } from '../../schemas/route';
import type { ExportHistoryService } from '../../services/exports/export_history_service';
import type { ExportService } from '../../services/processing/exports/export_service';
import { respond } from '../respond';

// Taking a photograph away at the reader's own settings (§10.5).
//
// **Answers with the file rather than a job id.** An export is one render the reader is
// waiting on, so the request is the wait: a queue with a place to collect the result later
// would be the right shape for a thousand photographs and the wrong one for the dialog.
//
// **One photograph per request**, so a selection is this route in a loop. The client is what
// holds the destination - a directory handle, the downloads folder, a folder the shell picked
// - so it is what places each file, and the progress it draws is its own loop counter.

// Quotes and backslashes would end the header's quoted-string early, and a photograph's own
// name is free to contain either.
function attachment(filename: string): string {
  return `attachment; filename="${filename.replace(/["\\]/g, '')}"`;
}

export class ExportApi {
  constructor(
    private readonly exports: ExportService,
    private readonly history: ExportHistoryService,
    /**
     * How far into the photograph in flight the render is, for the bar the dialog left behind.
     *
     * On the stream rather than in this response, because the response *is* the file: the reader
     * is waiting on it, so anything said before it arrives has to reach them another way.
     */
    private readonly progressed: (progress: ExportProgress) => void = () => {},
  ) {}

  get routes(): Hono {
    const app = new Hono();

    app.post(route(PathSegment.export()), async (c) => {
      const parsed = ExportRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'not an export request');
      const { photoId, options, runId } = parsed.data;
      // The tile the history lists this export under is a second size off this same render
      // (§10.5.2), so it is asked for here or not at all - and the row is written here with
      // it, rather than the picture going out to the client and coming back.
      const file = await this.exports.exportOne(
        photoId,
        options,
        runId != null,
        runId == null ?
          undefined
        : (fraction) => this.progressed({ run_id: runId, photo_id: photoId, fraction }),
      );
      if (runId != null) this.history.began(runId, photoId, options, file.thumbnail);

      return new Response(new Uint8Array(file.bytes), {
        headers: {
          'Content-Type': file.mediaType,
          'Content-Disposition': attachment(file.filename),
          // Never cached: the same URL answers differently for every set of options, and the
          // options are in the body where no cache can see them.
          'Cache-Control': 'no-store',
        },
      });
    });

    // Where a file landed, which the render could not know: the sink that wrote it says so,
    // and until it does the row is not a history entry and is not listed.
    app.post(route(PathSegment.exports(), PathSegment.landed()), async (c) => {
      const parsed = RecordExportRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'not an export to record');
      this.history.landed(parsed.data);
      return c.body(null, 204);
    });

    app.get(route(PathSegment.exports()), (c) => c.json(respond(ExportRunsSchema, this.history.list())));

    // What a run still waiting to be written is about, so the queue lists the same row the
    // history will. A POST because a selection's worth of ids does not go in a query string.
    app.post(route(PathSegment.exports(), PathSegment.queued()), async (c) => {
      const parsed = QueuedExportsRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'not a queued export');
      return c.json(respond(QueuedPhotosSchema, this.history.queued(parsed.data.photo_ids, parsed.data.include_edits)));
    });

    // Before the row below it, which would otherwise take `runs` for an export's id.
    app.delete(route(PathSegment.exports(), PathSegment.runs(), PathSegment.param('runId')), (c) => {
      this.history.forgetRun(c.req.param('runId'));
      return c.body(null, 204);
    });

    app.delete(route(PathSegment.exports(), PathSegment.param('id')), (c) => {
      this.history.forget(c.req.param('id'));
      return c.body(null, 204);
    });

    return app;
  }

  /**
   * The tile beside a history row, which is a picture the browser loads rather than a call it
   * makes - so it hangs off `/image` with everything else an `<img>` asks for.
   */
  get imageRoutes(): Hono {
    const app = new Hono();

    app.get(route(PathSegment.exports(), PathSegment.param('id')), (c) => {
      const thumbnail = this.history.thumbnailFor(c.req.param('id'));
      if (thumbnail == null) throw new AppError('NOT_FOUND', 'that export has no thumbnail');
      return new Response(new Uint8Array(thumbnail), {
        headers: {
          'Content-Type': 'image/avif',
          // A row's picture is written once and never again, so the browser need not ask twice.
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    });

    return app;
  }
}

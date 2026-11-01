import { Hono } from 'hono';
import {
  ImportFileIdsSchema,
  ImportHeadersRequestSchema,
  ImportHeadersSchema,
  ImportJobOrNoneSchema,
  ImportJobSchema,
  ImportScanRequestSchema,
  ImportScanSchema,
  ImportVolumesSchema,
  StartImportRequestSchema,
} from '../../schemas/imports';
import { PathSegment, route } from '../../schemas/route';
import type { ImportService } from '../../services/imports/import_service';
import { listVolumes } from '../../utils/volumes';
import { takeAsLongAsItTakes } from '../long_requests';
import { respond } from '../respond';

const SCAN_PICTURE_CACHE = 'private, max-age=3600, immutable';

export class ImportsApi {
  constructor(private readonly imports: ImportService) {}

  get routes(): Hono {
    const app = new Hono();

    app.get(route(PathSegment.volumes()), async (c) =>
      c.json(respond(ImportVolumesSchema, await listVolumes())),
    );

    app.post(route(PathSegment.scans()), async (c) => {
      takeAsLongAsItTakes(c);
      const { source } = ImportScanRequestSchema.parse(await c.req.json());
      return c.json(respond(ImportScanSchema, await this.imports.scan(source)));
    });

    app.get(
      route(
        PathSegment.scans(),
        PathSegment.param('scanId'),
        PathSegment.libraries(),
        PathSegment.param('libraryId'),
      ),
      (c) =>
        c.json(
          respond(
            ImportFileIdsSchema,
            this.imports.inLibrary(c.req.param('scanId'), c.req.param('libraryId')),
          ),
        ),
    );

    app.post(
      route(PathSegment.scans(), PathSegment.param('scanId'), PathSegment.headers()),
      async (c) => {
        takeAsLongAsItTakes(c);
        const { file_ids } = ImportHeadersRequestSchema.parse(await c.req.json());
        return c.json(
          respond(
            ImportHeadersSchema,
            await this.imports.readHeaders(c.req.param('scanId'), file_ids),
          ),
        );
      },
    );

    app.get(route(PathSegment.job()), (c) =>
      c.json(respond(ImportJobOrNoneSchema, this.imports.currentJob())),
    );

    app.post(route(PathSegment.job()), async (c) => {
      const request = StartImportRequestSchema.parse(await c.req.json());
      return c.json(respond(ImportJobSchema, await this.imports.start(request)), 201);
    });

    app.post(route(PathSegment.job(), PathSegment.cancel()), (c) => {
      this.imports.stop();
      return c.body(null, 204);
    });

    return app;
  }

  get imageRoutes(): Hono {
    const app = new Hono();

    app.get(
      route(PathSegment.imports(), PathSegment.param('scanId'), PathSegment.param('fileId')),
      async (c) => {
        const picture = await this.imports.picture(
          c.req.param('scanId'),
          Number(c.req.param('fileId')),
        );
        return picture.kind === 'file'
          ? new Response(Bun.file(picture.absPath), {
              headers: { 'Content-Type': picture.mediaType, 'Cache-Control': SCAN_PICTURE_CACHE },
            })
          : new Response(new Uint8Array(picture.bytes), {
              headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': SCAN_PICTURE_CACHE },
            });
      },
    );

    return app;
  }
}

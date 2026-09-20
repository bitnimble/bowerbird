import { type ExportRequest, ExportRequestSchema } from '../../../src/schemas/export';
import {
  type ExportRun,
  ExportRunsSchema,
  type QueuedExportsRequest,
  QueuedExportsRequestSchema,
  type QueuedPhoto,
  QueuedPhotosSchema,
  type RecordExportRequest,
  RecordExportRequestSchema,
} from '../../../src/schemas/exports';
import { PathSegment, route } from '../../../src/schemas/route';
import { assetUrl } from './transport';
import { NothingSchema, request, requestFile } from './request';

export const exportsApi = {
  // Answers with the file rather than a job id: an export is one render, and a reader
  // watching a dialog would rather wait for it than be told where to collect it. One
  // photograph per call, a selection being this in a loop (§10.5.1).
  create: (body: ExportRequest): Promise<{ bytes: Uint8Array; mediaType: string; filename: string | null }> =>
    requestFile('POST', route(PathSegment.api(), PathSegment.export()), ExportRequestSchema.parse(body)),
  // Where a file landed, said once it has: the render wrote the row and its tile, and the
  // destination is the one part of an export the server never sees.
  record: (body: RecordExportRequest): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.exports(), PathSegment.landed()),
      RecordExportRequestSchema.parse(body),
    ),
  list: (): Promise<ExportRun[]> => request(ExportRunsSchema, 'GET', route(PathSegment.api(), PathSegment.exports())),
  // The photographs a queued run is about, in the shape the history states a written one in.
  queued: (body: QueuedExportsRequest): Promise<QueuedPhoto[]> =>
    request(
      QueuedPhotosSchema,
      'POST',
      route(PathSegment.api(), PathSegment.exports(), PathSegment.queued()),
      QueuedExportsRequestSchema.parse(body),
    ),
  forget: (id: string): Promise<void> =>
    request(NothingSchema, 'DELETE', route(PathSegment.api(), PathSegment.exports(), id)),
  forgetRun: (runId: string): Promise<void> =>
    request(NothingSchema, 'DELETE', route(PathSegment.api(), PathSegment.exports(), PathSegment.runs(), runId)),

  // The picture beside a history row, written when the export was and never rewritten - so
  // unversioned, and served with a year's cache behind it.
  thumbnailUrl: (exportId: string): string => assetUrl(route(PathSegment.image(), PathSegment.exports(), exportId)),
};

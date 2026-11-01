import {
  type ImportHeader,
  ImportFileIdsSchema,
  ImportHeadersRequestSchema,
  ImportHeadersSchema,
  type ImportJob,
  ImportJobOrNoneSchema,
  ImportJobSchema,
  type ImportScan,
  ImportScanRequestSchema,
  ImportScanSchema,
  type ImportVolume,
  ImportVolumesSchema,
  type StartImportRequest,
  StartImportRequestSchema,
} from '../../../src/schemas/imports';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

const IMPORTS = route(PathSegment.api(), PathSegment.imports());

export const importsApi = {
  volumes: (): Promise<ImportVolume[]> =>
    request(ImportVolumesSchema, 'GET', `${IMPORTS}${route(PathSegment.volumes())}`),
  scan: (source: string): Promise<ImportScan> =>
    request(
      ImportScanSchema,
      'POST',
      `${IMPORTS}${route(PathSegment.scans())}`,
      ImportScanRequestSchema.parse({ source }),
    ),
  inLibrary: (scanId: string, libraryId: string): Promise<number[]> =>
    request(
      ImportFileIdsSchema,
      'GET',
      `${IMPORTS}${route(PathSegment.scans(), scanId, PathSegment.libraries(), libraryId)}`,
    ),
  headers: (scanId: string, fileIds: number[]): Promise<ImportHeader[]> =>
    request(
      ImportHeadersSchema,
      'POST',
      `${IMPORTS}${route(PathSegment.scans(), scanId, PathSegment.headers())}`,
      ImportHeadersRequestSchema.parse({ file_ids: fileIds }),
    ),
  currentJob: (): Promise<ImportJob | null> =>
    request(ImportJobOrNoneSchema, 'GET', `${IMPORTS}${route(PathSegment.job())}`),
  start: (body: StartImportRequest): Promise<ImportJob> =>
    request(
      ImportJobSchema,
      'POST',
      `${IMPORTS}${route(PathSegment.job())}`,
      StartImportRequestSchema.parse(body),
    ),
  stop: (): Promise<void> =>
    request(NothingSchema, 'POST', `${IMPORTS}${route(PathSegment.job(), PathSegment.cancel())}`),
  pictureUrl: (scanId: string, fileId: number): string =>
    route(PathSegment.image(), PathSegment.imports(), scanId, String(fileId)),
};

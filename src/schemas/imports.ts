import { z } from 'zod';
import { IdSchema } from './common';
import { PhotoFormatSchema } from './photos';

export const ImportVolumeSchema = z.object({ name: z.string(), path: z.string() });
export const ImportVolumesSchema = z.array(ImportVolumeSchema);
export type ImportVolume = z.infer<typeof ImportVolumeSchema>;

export const ImportScanRequestSchema = z.object({ source: z.string().min(1) });

export const ImportFileSchema = z.object({
  id: z.number().int(),
  rel_path: z.string(),
  format: PhotoFormatSchema,
  file_size: z.number(),
  modified_at: z.string(),
});
export type ImportFile = z.infer<typeof ImportFileSchema>;

export const ImportScanSchema = z.object({
  id: IdSchema,
  source: z.string(),
  files: z.array(ImportFileSchema),
  complete: z.boolean(),
});
export type ImportScan = z.infer<typeof ImportScanSchema>;

export const ImportFileIdsSchema = z.array(z.number().int());

export const ImportHeadersRequestSchema = z.object({ file_ids: ImportFileIdsSchema });

export const ImportHeaderSchema = z.object({
  file_id: z.number().int(),
  date_taken: z.string().nullable(),
  camera_model: z.string().nullable(),
  lens_model: z.string().nullable(),
});
export type ImportHeader = z.infer<typeof ImportHeaderSchema>;
export const ImportHeadersSchema = z.array(ImportHeaderSchema);

export const StartImportRequestSchema = z.object({
  scan_id: IdSchema,
  library_id: IdSchema,
  shoot_id: IdSchema.nullable(),
  file_ids: ImportFileIdsSchema.min(1),
  delete_originals: z.boolean().optional(),
});
export type StartImportRequest = z.infer<typeof StartImportRequestSchema>;

export const ImportJobSchema = z.object({
  id: IdSchema,
  library_id: IdSchema,
  shoot_id: IdSchema.nullable(),
  status: z.enum(['copying', 'finished', 'stopped']),
  total: z.number().int(),
  copied: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  failed_names: z.array(z.string()),
  deleted: z.number().int(),
  kept: z.number().int(),
  kept_names: z.array(z.string()),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;
export const ImportJobOrNoneSchema = ImportJobSchema.nullable();

import { z } from 'zod';
import { OrderingSchema, UuidSchema } from './common';

export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  data_path: z.string().optional(),
  ordering: OrderingSchema.default('taken_asc'),
});
export type CreateLibraryRequest = z.infer<typeof CreateLibraryRequestSchema>;

// Where thumbnails and previews get their pixels (§10.2). 'embedded' lifts the
// camera's own JPEG out of the RAW, which needs no demosaic; 'render' demosaics
// at full resolution and is the only source with the headroom for HDR.
export const PreviewSourceSchema = z.enum(['embedded', 'render']);
export type PreviewSource = z.infer<typeof PreviewSourceSchema>;

export const LibrarySchema = z.object({
  id: UuidSchema,
  root_path: z.string(),
  data_path: z.string().nullable(),
  ordering: OrderingSchema,
  preview_source: PreviewSourceSchema,
  preview_hdr: z.boolean(),
  preview_hdr_video: z.boolean(),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});
export type Library = z.infer<typeof LibrarySchema>;

// Every field optional: the settings UI changes one control at a time, and a
// partial update must not reset the others to their defaults.
export const UpdateLibraryRequestSchema = z.object({
  ordering: OrderingSchema.optional(),
  preview_source: PreviewSourceSchema.optional(),
  preview_hdr: z.boolean().optional(),
  preview_hdr_video: z.boolean().optional(),
});
export type UpdateLibraryRequest = z.infer<typeof UpdateLibraryRequestSchema>;

export const LibrarySyncStatusSchema = z.object({
  library_id: UuidSchema,
  status: z.enum(['idle', 'scanning', 'processing']),
  // How many files the scan will look at, and how many it has looked at so far.
  // The pair is the scan's progress while `status` is 'scanning' (§9.6), and both
  // settle on the number of files found once it is over.
  photos_to_scan: z.number().int(),
  photos_scanned: z.number().int(),
  photos_added: z.number().int(),
  photos_removed: z.number().int(),
  photos_moved: z.number().int(),
  photos_modified: z.number().int(),
  photos_processing: z.number().int(),
  photos_processed: z.number().int(),
});
export type LibrarySyncStatus = z.infer<typeof LibrarySyncStatusSchema>;

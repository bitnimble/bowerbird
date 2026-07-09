import { z } from 'zod';
import { OrderingSchema, UuidSchema } from './common';

export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  data_path: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});
export type CreateLibraryRequest = z.infer<typeof CreateLibraryRequestSchema>;

export const LibrarySchema = z.object({
  id: UuidSchema,
  root_path: z.string(),
  data_path: z.string().nullable(),
  ordering: OrderingSchema,
});
export type Library = z.infer<typeof LibrarySchema>;

export const LibrarySyncStatusSchema = z.object({
  library_id: UuidSchema,
  status: z.enum(['idle', 'scanning', 'processing']),
  photos_scanned: z.number().int(),
  photos_added: z.number().int(),
  photos_removed: z.number().int(),
  photos_moved: z.number().int(),
  photos_modified: z.number().int(),
  photos_processing: z.number().int(),
  photos_processed: z.number().int(),
});
export type LibrarySyncStatus = z.infer<typeof LibrarySyncStatusSchema>;

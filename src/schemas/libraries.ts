import { z } from 'zod';
import { OrderingSchema, RenditionSourceSchema, UuidSchema } from './common';

export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  data_path: z.string().optional(),
  // Omitted or blank means "call it after its root folder", which is what a
  // library shows until someone gives it a name of its own.
  name: z.string().trim().optional(),
  ordering: OrderingSchema.default('taken_asc'),
});
export type CreateLibraryRequest = z.infer<typeof CreateLibraryRequestSchema>;

export const LibrarySchema = z.object({
  id: UuidSchema,
  root_path: z.string(),
  data_path: z.string().nullable(),
  name: z.string().nullable(),
  ordering: OrderingSchema,
  rendition_source: RenditionSourceSchema,
  rendition_hdr: z.boolean(),
  rendition_hdr_video: z.boolean(),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});
export type Library = z.infer<typeof LibrarySchema>;

// Every field optional: the settings UI changes one control at a time, and a
// partial update must not reset the others to their defaults.
export const UpdateLibraryRequestSchema = z.object({
  // Blank clears it, so a library can be handed back to its folder name.
  name: z.string().trim().optional(),
  ordering: OrderingSchema.optional(),
  rendition_source: RenditionSourceSchema.optional(),
  rendition_hdr: z.boolean().optional(),
  rendition_hdr_video: z.boolean().optional(),
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

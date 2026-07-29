import { z } from 'zod';
import { OrderingSchema, RenditionSourceSchema, UuidSchema } from './common';

export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  data_path: z.string().optional(),
  // Omitted or blank means "call it after its root folder", which is what a
  // library shows until someone gives it a name of its own.
  name: z.string().trim().optional(),
  ordering: OrderingSchema.default('taken_asc'),
  // Asked here rather than left to Settings because both change what the first
  // sync imports, and a library that has already built renditions for a folder of
  // decade-old rejects has answered the question the expensive way (§4.1).
  include_subfolders: z.boolean().default(true),
  mirror_shoots: z.boolean().default(true),
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
  include_subfolders: z.boolean(),
  mirror_shoots: z.boolean(),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});
export type Library = z.infer<typeof LibrarySchema>;

// §4.7. 'excluded' keeps a folder out of the scan entirely; 'plain' lets its
// photos in but keeps mirroring from making it a shoot.
export const FolderRuleKindSchema = z.enum(['excluded', 'plain']);
export type FolderRuleKind = z.infer<typeof FolderRuleKindSchema>;

export const FolderRuleSchema = z.object({
  folder_path: z.string(),
  rule: FolderRuleKindSchema,
});
export type FolderRule = z.infer<typeof FolderRuleSchema>;

// Root-relative, forward slashes, no trailing separator and no traversal. A rule
// is matched against paths the scan builds segment by segment, so anything else
// stores a row the UI lists as active while nothing it names is ever skipped.
export const FolderPathSchema = z
  .string()
  .min(1)
  .transform((p) => p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, ''))
  .refine((p) => p !== '' && !p.startsWith('/') && !/^[A-Za-z]:/.test(p), { message: 'folder must be relative to the library root' })
  .refine((p) => !p.split('/').some((segment) => segment === '.' || segment === '..' || segment === ''), {
    message: 'folder must not contain "." or ".." segments',
  });

export const SetFolderRuleRequestSchema = z.object({
  folder_path: FolderPathSchema,
  rule: FolderRuleKindSchema,
});
export type SetFolderRuleRequest = z.infer<typeof SetFolderRuleRequestSchema>;

// Every field optional: the settings UI changes one control at a time, and a
// partial update must not reset the others to their defaults.
export const UpdateLibraryRequestSchema = z.object({
  // Blank clears it, so a library can be handed back to its folder name.
  name: z.string().trim().optional(),
  ordering: OrderingSchema.optional(),
  rendition_source: RenditionSourceSchema.optional(),
  rendition_hdr: z.boolean().optional(),
  rendition_hdr_video: z.boolean().optional(),
  include_subfolders: z.boolean().optional(),
  mirror_shoots: z.boolean().optional(),
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

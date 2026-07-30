import { z } from 'zod';
import { OrderingSchema, RenditionSourceSchema, UuidSchema } from './common';

// One folder name, not a path: it names the library's single bin, at its root,
// and the rest of that bin's layout mirrors the folders photographs came from
// (§12.3).
export const BinNameSchema = z
  .string()
  .trim()
  .min(1)
  .refine((name) => !/[/\\]/.test(name), { message: 'bin folder name must be a single folder name' })
  .refine((name) => name !== '.' && name !== '..', { message: 'bin folder name must not be "." or ".."' });

export const CreateLibraryRequestSchema = z.object({
  root_path: z.string().min(1),
  data_path: z.string().optional(),
  // Asked at creation and never after: the name is what the scan skips, so
  // changing it later would strand every already-binned RAW in a folder the scan
  // would then walk back in (§12.3). A root that already holds this folder is
  // refused rather than adopted, since its contents would silently never import.
  bin_name: BinNameSchema.default('Bin'),
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
  bin_name: z.string(),
  name: z.string().nullable(),
  ordering: OrderingSchema,
  rendition_source: RenditionSourceSchema,
  rendition_hdr: z.boolean(),
  rendition_hdr_video: z.boolean(),
  include_subfolders: z.boolean(),
  mirror_shoots: z.boolean(),
  // Automatic photo stacking (§19.4). Per library rather than global because one
  // catalogue may be burst-heavy sport and another a studio where every frame is
  // deliberate, and the two want different answers.
  auto_stack: z.boolean(),
  // How alike two frames must be, in [0, 1]. 0.78 rather than a rounder number
  // because that is where the labelled folder the descriptor was tuned against
  // reproduces (§19.9).
  auto_stack_similarity: z.number().min(0).max(1),
  // How far apart two frames may be and still be considered adjacent. It gates
  // adjacency only: a stack chains as far as it likes, bounded instead by every
  // member matching every other.
  auto_stack_window_seconds: z.number().int().min(1),
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
  auto_stack: z.boolean().optional(),
  auto_stack_similarity: z.number().min(0).max(1).optional(),
  auto_stack_window_seconds: z.number().int().min(1).optional(),
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

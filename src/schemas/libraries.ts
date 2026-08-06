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
  // The app writes nothing under this root: no bin, no shoot folders, no moves.
  // Refused over a root that is actually writable only in the other direction -
  // a false here over a root that is not is a READ_ONLY (§2.1).
  read_only: z.boolean().default(false),
  // A root that already holds this folder is refused rather than adopted, since
  // its contents would silently never import. Forced to null when `read_only` is
  // set: a bin is a folder the app makes under the root.
  bin_name: BinNameSchema.nullable().default('Bin'),
  // Omitted or blank: named after the root folder (a year leaf includes its
  // parent) and that name is stored, not held as a placeholder.
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
  // NULL means this library has no bin at all (§2). The bin folder's recorded
  // identity is deliberately not here: it would leak into every API response.
  bin_name: z.string().nullable(),
  read_only: z.boolean().default(false),
  name: z.string().min(1),
  ordering: OrderingSchema,
  // Matching the column defaults: the embedded JPEG needs no demosaic, and HDR
  // is opt-in because it only applies to a render.
  rendition_source: RenditionSourceSchema.default('embedded'),
  rendition_hdr: z.boolean().default(false),
  include_subfolders: z.boolean().default(true),
  mirror_shoots: z.boolean().default(true),
  // Automatic photo stacking (§19.4). Per library rather than global because one
  // catalogue may be burst-heavy sport and another a studio where every frame is
  // deliberate, and the two want different answers. Matching the column defaults
  // (§19.2): stacking is on, at the threshold and window the labelled folder settled on.
  auto_stack: z.boolean().default(true),
  // How alike two frames must be, in [0, 1]. 0.78 rather than a rounder number
  // because that is where the labelled folder the descriptor was tuned against
  // reproduces (§19.9).
  auto_stack_similarity: z.number().min(0).max(1).default(0.78),
  // How far apart two frames may be and still be considered adjacent. It gates
  // adjacency only: a stack chains as far as it likes, bounded instead by every
  // member matching every other.
  auto_stack_window_seconds: z.number().int().min(1).default(60),
  last_synced_at: z.string().nullable(),
  photo_count: z.number().int(),
});
export type Library = z.infer<typeof LibrarySchema>;

// The knobs the settings page can reset. Derived from the schema's `.default()`s.
export const LibrarySettingsSchema = LibrarySchema.pick({
  include_subfolders: true,
  mirror_shoots: true,
  rendition_source: true,
  rendition_hdr: true,
  auto_stack: true,
  auto_stack_similarity: true,
  auto_stack_window_seconds: true,
});
export type LibrarySettings = z.infer<typeof LibrarySettingsSchema>;
export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = LibrarySettingsSchema.parse({});

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
  name: z.string().trim().min(1).optional(),
  read_only: z.boolean().optional(),
  // On a library that already has one this is a **rename**, which moves the
  // folder (§2.4), not an error.
  bin_name: BinNameSchema.optional(),
  ordering: OrderingSchema.optional(),
  rendition_source: RenditionSourceSchema.optional(),
  rendition_hdr: z.boolean().optional(),
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

import { z } from 'zod';
import { OrderingSchema, RenditionSourceSchema, IdSchema } from './common';
import { OptionalStagesSchema, RenderTimingsSchema } from './render_stages';

// One folder name, not a path: it names the library's single bin, at its root,
// and the rest of that bin's layout mirrors the folders photographs came from
// (§12.3).
export const DEFAULT_BIN_NAME = 'Bin';

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
  // a false here over a root that is not is a READ_ONLY (§4.1).
  read_only: z.boolean().default(false),
  // A root that already holds this folder has it adopted: the bin channel walks
  // it and imports what it holds as already-binned (§12.3). Forced to null when
  // `read_only` is set: a bin is a folder the app makes under the root.
  bin_name: BinNameSchema.nullable().default(DEFAULT_BIN_NAME),
  // Omitted or blank: named after the root folder (a year leaf includes its
  // parent) and that name is stored, not held as a placeholder.
  name: z.string().trim().optional(),
  ordering: OrderingSchema.default('taken_asc'),
  // Asked here rather than left to Settings because every one of them decides
  // what the first import does, and the import begins as the row lands (§9.8) -
  // so any of them PATCHed after the create is a setting the import has already
  // answered for itself. A rendition source arrives with a render per photo
  // dispatched, which Stop cannot call back until it has landed; stacking has
  // already grouped the frames it was going to group, and turning it off
  // afterwards leaves them grouped (§19.4).
  include_subfolders: z.boolean().default(true),
  include_non_raw: z.boolean().default(false),
  rendition_source: RenditionSourceSchema.default('render'),
  auto_stack: z.boolean().default(true),
});
export type CreateLibraryRequest = z.infer<typeof CreateLibraryRequestSchema>;

export const LibrarySchema = z.object({
  id: IdSchema,
  root_path: z.string(),
  // NULL means this library has no bin at all (§4.1). The bin folder's recorded
  // identity is deliberately not here: it would leak into every API response.
  bin_name: z.string().nullable(),
  read_only: z.boolean().default(false),
  name: z.string().min(1),
  ordering: OrderingSchema,
  // Matching the column defaults: a render, in HDR, because that is what the RAW
  // has and the embedded JPEG throws away.
  rendition_source: RenditionSourceSchema.default('render'),
  rendition_hdr: z.boolean().default(true),
  // Which stages the two rendered renditions leave out (§10.1). Empty is every stage running,
  // which is what a library gets until somebody trades one away for the time it costs. Per
  // rendition because the two are looked at differently: `full` is what the viewer opens and
  // `max` is what gets pixel-peeped. Not retroactive, like every setting in this panel.
  render_skip_full: OptionalStagesSchema.default([]),
  render_skip_max: OptionalStagesSchema.default([]),
  // What those renders were measured to cost on this device, where a benchmark has run. Read
  // rather than set: the panel shows estimates until it has one of these to show instead.
  render_timings: RenderTimingsSchema.default({}),
  include_subfolders: z.boolean().default(true),
  // Whether JPEG, PNG, HEIC and AVIF are photographs here. Off by default: beside
  // a folder of RAWs they are usually the camera's own copies of frames the
  // library already holds, and importing both makes every frame two rows.
  include_non_raw: z.boolean().default(false),
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

export const LibrariesSchema = z.array(LibrarySchema);

export const LibraryFoldersSchema = z.array(z.string());

export const DetectStacksResponseSchema = z.object({ stacks: z.number().int() });
export type DetectStacksResponse = z.infer<typeof DetectStacksResponseSchema>;

// The knobs the settings page can reset. Derived from the schema's `.default()`s.
export const LibrarySettingsSchema = LibrarySchema.pick({
  include_subfolders: true,
  include_non_raw: true,
  rendition_source: true,
  rendition_hdr: true,
  render_skip_full: true,
  render_skip_max: true,
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

export const FolderRulesSchema = z.array(FolderRuleSchema);

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
  // folder (§4.1), not an error.
  bin_name: BinNameSchema.optional(),
  ordering: OrderingSchema.optional(),
  rendition_source: RenditionSourceSchema.optional(),
  rendition_hdr: z.boolean().optional(),
  render_skip_full: OptionalStagesSchema.optional(),
  render_skip_max: OptionalStagesSchema.optional(),
  include_subfolders: z.boolean().optional(),
  include_non_raw: z.boolean().optional(),
  auto_stack: z.boolean().optional(),
  auto_stack_similarity: z.number().min(0).max(1).optional(),
  auto_stack_window_seconds: z.number().int().min(1).optional(),
});
export type UpdateLibraryRequest = z.infer<typeof UpdateLibraryRequestSchema>;

export const LibraryScanStatusSchema = z.object({
  library_id: IdSchema,
  status: z.enum(['idle', 'processing', 'rendition']),
  // How many files the scan will look at, and how many it has looked at so far.
  // The pair is the scan's progress while `status` is 'processing' (§9.6), and both
  // settle on the number of files found once it is over.
  photos_to_scan: z.number().int(),
  photos_scanned: z.number().int(),
  photos_added: z.number().int(),
  photos_removed: z.number().int(),
  photos_moved: z.number().int(),
  photos_modified: z.number().int(),
  photos_processing: z.number().int(),
  photos_processed: z.number().int(),
  // Photos per second over the last batch of rows a first scan wrote down, which is
  // the only stretch of a run whose throughput the server itself times. Null
  // everywhere else, where the client's own counting is what there is.
  photos_per_second: z.number().nullable(),
});
export type LibraryScanStatus = z.infer<typeof LibraryScanStatusSchema>;

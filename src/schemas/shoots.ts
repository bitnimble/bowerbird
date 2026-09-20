import { z } from 'zod';
import { OrderingSchema, IdSchema } from './common';

// A shoot name seeds its folder at create time (§4.3), so it must be a single
// on-disk segment: otherwise `path.join` could escape the library root (path
// traversal) or create phantom folders. Renaming never touches the folder, so
// this only has to hold for the name a shoot is created with.
export const ShootNameSchema = z
  .string()
  .min(1)
  .refine((n) => !/[/\\]/.test(n) && n !== '.' && n !== '..' && !n.startsWith('.') && !n.includes('\0'), {
    message: 'name must be a single folder segment (no "/", "\\", leading ".", or path tokens)',
  });

// Whether a listing includes the shoots put away (§12.4). Off by default, which is the point: a
// consumer that has not thought about hiding gets the shoots a reader is working with, rather than
// having to remember a filter that nothing would fail without. Shared by the shoots listing and the
// folder tree, because it is one question - the tree has to lose a hidden shoot's folders along with
// the shoot, or they come back as unclaimed folders offering to adopt it.
export const HiddenShootsQuerySchema = z.object({
  include_hidden: z.stringbool().default(false),
});
export type HiddenShootsQuery = z.infer<typeof HiddenShootsQuerySchema>;

export const CreateShootRequestSchema = z.object({
  library_id: IdSchema,
  // Which folder the shoot's own folder is created in, relative to the library
  // root, where "" is the root itself. The parent shoot is derived from it
  // rather than chosen alongside it, so the shoot tree can never disagree with
  // the folders on disk, and a shoot can sit under a folder that is not itself
  // a shoot.
  parent_path: z.string().default(''),
  name: ShootNameSchema,
  description: z.string().optional(),
  ordering: OrderingSchema.default('taken_asc'),
});
export type CreateShootRequest = z.infer<typeof CreateShootRequestSchema>;

export const UpdateShootRequestSchema = z.object({
  name: ShootNameSchema.optional(),
  description: z.string().optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: IdSchema.nullable().optional(),
  is_hidden: z.boolean().optional(),
});
export type UpdateShootRequest = z.infer<typeof UpdateShootRequestSchema>;

// What becomes of the photographs, asked rather than assumed (§8.5): 'keep'
// leaves them in the library and marks the folder plain, 'remove' takes their
// rows and renditions with the shoot and excludes the folder. The reversible
// answer is the default.
export const DeleteShootQuerySchema = z.object({
  photos: z.enum(['keep', 'remove']).default('keep'),
});
export type DeleteShootQuery = z.infer<typeof DeleteShootQuerySchema>;

// What `photos: 'remove'` would actually destroy: every row under the folder,
// which is not the same set as the shoot's members. Photos in a `plain`
// subfolder belong to no shoot and are counted by neither `photo_count` nor a
// descendant's, and binned rows are excluded from every count on screen - yet
// both are deleted. The dialog states this number, so the server answers it with
// the same query the delete uses rather than the client inferring one.
export const ShootRemovalSchema = z.object({
  photos: z.number().int(),
});
export type ShootRemoval = z.infer<typeof ShootRemovalSchema>;

export const ShootSchema = z.object({
  id: IdSchema,
  parent_id: IdSchema.nullable(),
  library_id: IdSchema,
  folder_path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  banner_photo_id: IdSchema.nullable(),
  ordering: OrderingSchema,
  photo_count: z.number().int(),
  // Out of sight: put away itself, or sitting under a shoot that was (§12.4). The derived answer, so
  // a client greys and filters on this one field rather than walking the tree to work it out.
  is_hidden: z.boolean(),
  // Whether this shoot is the one that was put away, rather than being under it. Only this is
  // undoable, so it is what decides whether a row may offer to bring the shoot back: unhiding a
  // descendant would clear a flag that is already clear and change nothing on screen.
  hidden_directly: z.boolean(),
});
export type Shoot = z.infer<typeof ShootSchema>;

export const ShootListSchema = z.array(ShootSchema);

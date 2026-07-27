import { z } from 'zod';
import { OrderingSchema, UuidSchema } from './common';

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

export const CreateShootRequestSchema = z.object({
  library_id: UuidSchema,
  parent_id: UuidSchema.optional(),
  name: ShootNameSchema,
  description: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});
export type CreateShootRequest = z.infer<typeof CreateShootRequestSchema>;

export const UpdateShootRequestSchema = z.object({
  name: ShootNameSchema.optional(),
  description: z.string().optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: UuidSchema.nullable().optional(),
});
export type UpdateShootRequest = z.infer<typeof UpdateShootRequestSchema>;

export const ShootSchema = z.object({
  id: UuidSchema,
  parent_id: UuidSchema.nullable(),
  library_id: UuidSchema,
  folder_path: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  banner_photo_id: UuidSchema.nullable(),
  ordering: OrderingSchema,
  photo_count: z.number().int(),
});
export type Shoot = z.infer<typeof ShootSchema>;

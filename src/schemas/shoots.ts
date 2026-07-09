import { z } from 'zod';
import { OrderingSchema, UuidSchema } from './common';

export const CreateShootRequestSchema = z.object({
  library_id: UuidSchema,
  parent_id: UuidSchema.optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  ordering: OrderingSchema.default('taken_desc'),
});
export type CreateShootRequest = z.infer<typeof CreateShootRequestSchema>;

export const UpdateShootRequestSchema = z.object({
  name: z.string().min(1).optional(),
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
});
export type Shoot = z.infer<typeof ShootSchema>;

import { z } from 'zod';
import { OrderingSchema, UuidSchema } from './common';

export const CreateAlbumRequestSchema = z.object({
  name: z.string().min(1),
  ordering: OrderingSchema.default('taken_asc'),
});
export type CreateAlbumRequest = z.infer<typeof CreateAlbumRequestSchema>;

export const UpdateAlbumRequestSchema = z.object({
  name: z.string().min(1).optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: UuidSchema.nullable().optional(),
});
export type UpdateAlbumRequest = z.infer<typeof UpdateAlbumRequestSchema>;

export const AlbumSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  ordering: OrderingSchema,
  banner_photo_id: UuidSchema.nullable(),
  photo_count: z.number().int(),
});
export type Album = z.infer<typeof AlbumSchema>;

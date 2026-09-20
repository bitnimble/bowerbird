import { z } from 'zod';
import { OrderingSchema, IdSchema } from './common';

export const CreateAlbumRequestSchema = z.object({
  name: z.string().min(1),
  ordering: OrderingSchema.default('taken_asc'),
});
export type CreateAlbumRequest = z.infer<typeof CreateAlbumRequestSchema>;

export const UpdateAlbumRequestSchema = z.object({
  name: z.string().min(1).optional(),
  ordering: OrderingSchema.optional(),
  banner_photo_id: IdSchema.nullable().optional(),
});
export type UpdateAlbumRequest = z.infer<typeof UpdateAlbumRequestSchema>;

export const AlbumSchema = z.object({
  id: IdSchema,
  name: z.string(),
  ordering: OrderingSchema,
  banner_photo_id: IdSchema.nullable(),
  photo_count: z.number().int(),
});
export type Album = z.infer<typeof AlbumSchema>;

export const AlbumListSchema = z.array(AlbumSchema);

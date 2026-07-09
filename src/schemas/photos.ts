import { z } from 'zod';
import { PaginationSchema, SoftDeleteFilterSchema, UuidSchema } from './common';

export const PhotoSummarySchema = z.object({
  id: UuidSchema,
  library_id: UuidSchema,
  shoot_id: UuidSchema.nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  ordering_date: z.string().nullable(),
  selected: z.boolean(),
  rating: z.number().int().min(0).max(5),
  is_missing: z.boolean(),
  is_deleted: z.boolean(),
});
export type PhotoSummary = z.infer<typeof PhotoSummarySchema>;

export const PhotoDetailSchema = PhotoSummarySchema.extend({
  file_path: z.string(),
  file_hash: z.string().nullable(),
  orientation: z.number().int(),
  date_taken: z.string().nullable(),
  date_added: z.string(),
  date_updated: z.string().nullable(),
  date_reprocessed: z.string().nullable(),
  needs_processing: z.boolean(),
  processing_error: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  notes: z.string().nullable(),
});
export type PhotoDetail = z.infer<typeof PhotoDetailSchema>;

export const PhotoListResponseSchema = z.object({
  photos: z.array(PhotoSummarySchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});
export type PhotoListResponse = z.infer<typeof PhotoListResponseSchema>;

export const UpdatePhotoRequestSchema = z.object({
  rating: z.number().int().min(0).max(5).optional(),
  selected: z.boolean().optional(),
  notes: z.string().optional(),
});
export type UpdatePhotoRequest = z.infer<typeof UpdatePhotoRequestSchema>;

// Boolean query params use stringbool() so ?is_missing=false parses as false.
export const PhotoListQuerySchema = PaginationSchema
  .extend(SoftDeleteFilterSchema.shape)
  .extend({
    is_missing: z.stringbool().optional(),
    needs_processing: z.stringbool().optional(),
  });
export type PhotoListQuery = z.infer<typeof PhotoListQuerySchema>;

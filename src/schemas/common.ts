import { z } from 'zod';

export const OrderingSchema = z.enum(['taken_asc', 'taken_desc', 'added_asc', 'added_desc']);
export type Ordering = z.infer<typeof OrderingSchema>;
// For `taken_*` orderings, photos with a NULL `date_taken` always sort last
// (SQL `ORDER BY date_taken IS NULL, date_taken <dir>`), regardless of direction.

export const PaginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const UuidSchema = z.uuid();

// Every list endpoint accepts this filter. Default excludes soft-deleted rows.
// stringbool(), not coerce.boolean(): Boolean("false") is true, so
// ?include_deleted=false would wrongly parse as true under coercion.
export const SoftDeleteFilterSchema = z.object({
  include_deleted: z.stringbool().default(false),
});
export type SoftDeleteFilter = z.infer<typeof SoftDeleteFilterSchema>;

// max bounds per-request work (each id can drive a file move / delete) and keeps
// the IN(...) placeholder count well under SQLite's variable limit. A client with
// a larger selection chunks it. 400 on overflow beats a 500 or a stalled request.
export const PhotoIdListSchema = z.object({
  photo_ids: z.array(UuidSchema).min(1).max(1000),
});
export type PhotoIdList = z.infer<typeof PhotoIdListSchema>;

// Query for the shoot/album photo-listing endpoints: pagination + soft-delete.
export const ScopedListQuerySchema = PaginationSchema.extend(SoftDeleteFilterSchema.shape);
export type ScopedListQuery = z.infer<typeof ScopedListQuerySchema>;

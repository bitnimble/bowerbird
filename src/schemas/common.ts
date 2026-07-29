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

// Where a rendition's pixels come from (§10.2). 'embedded' lifts the camera's own
// JPEG out of the RAW, which needs no demosaic; 'render' demosaics at full
// resolution and is the only source with the headroom for HDR. Shared because the
// library states which one to build with and each photo records which one was
// actually used, and the two must not drift apart.
export const RENDITION_SOURCES = ['embedded', 'render'] as const;
export const RenditionSourceSchema = z.enum(RENDITION_SOURCES);
export type RenditionSource = z.infer<typeof RenditionSourceSchema>;

// Every list endpoint accepts this filter. Default excludes soft-deleted rows.
// stringbool(), not coerce.boolean(): Boolean("false") is true, so
// ?include_deleted=false would wrongly parse as true under coercion.
export const SoftDeleteFilterSchema = z.object({
  include_deleted: z.stringbool().default(false),
});

// max bounds per-request work (each id can drive a file move / delete) and keeps
// the IN(...) placeholder count well under SQLite's variable limit. A client with
// a larger selection names it by position instead (PhotoSelectionSchema), or
// chunks. 400 on overflow beats a 500 or a stalled request.
export const PhotoIdListSchema = z.object({
  photo_ids: z.array(UuidSchema).min(1).max(1000),
});

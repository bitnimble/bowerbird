import { z } from 'zod';
import { OrderingSchema, PaginationSchema, PhotoIdListSchema, SoftDeleteFilterSchema, UuidSchema } from './common';
import { PreviewRenditionSchema } from './settings';

// The cull verdict. 'untriaged' is the wire spelling of a NULL column: a photo
// the user has not judged yet, which is the set they most often want to see.
export const TriageSchema = z.enum(['untriaged', 'picked', 'rejected']);
export type Triage = z.infer<typeof TriageSchema>;

// 'embedded' = the camera's own JPEG lifted out of the RAW, 'render' = a full
// demosaic. See §10.3 for the trade-off.
export const ThumbnailSourceSchema = z.enum(['embedded', 'render']);

export const PhotoSummarySchema = z.object({
  id: UuidSchema,
  library_id: UuidSchema,
  shoot_id: UuidSchema.nullable(),
  // Included in the summary because a grid tile is identified by its filename;
  // without it every client would have to fetch the detail of every row.
  file_path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  ordering_date: z.string().nullable(),
  triage: TriageSchema,
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
  // Size of the original RAW on disk, in bytes.
  file_size: z.number().int().nullable(),
  // Shooting metadata off the RAW header (§11.1); null when the camera did not
  // record it. shutter_speed is in seconds, so 1/250s is 0.004.
  iso: z.number().nullable(),
  shutter_speed: z.number().nullable(),
  aperture: z.number().nullable(),
  focal_length: z.number().nullable(),
  // Body and lens, off the RAW header. LibRaw's normalized names where it has
  // them; null when the camera recorded nothing (fixed-lens bodies report no lens).
  camera_make: z.string().nullable(),
  camera_model: z.string().nullable(),
  lens_model: z.string().nullable(),
  // Which pixels the thumbnails were built from; NULL before first processing.
  thumbnail_source: ThumbnailSourceSchema.nullable(),
  thumbnail_hdr: z.boolean(),
  // The rendition this photo was last viewed in, remembered only for the mode
  // that reopens it there; null until then.
  preview_rendition: PreviewRenditionSchema.nullable(),
  // Whether the full-resolution lossless render has been built (§10.5). A disk
  // check rather than a column: the file is the cache, so it is the truth.
  has_lossless: z.boolean(),
  // Whether an HDR video rendition of this photo's preview exists, so the client
  // knows it may reach for it on a browser that needs one (§10.7).
  preview_hdr_video: z.boolean(),
  // The same, for the full-resolution view (§10.5).
  has_lossless_video: z.boolean(),
  // Albums this photo belongs to. On the detail only: it needs a second query,
  // and a grid of 100 tiles has no use for it.
  album_ids: z.array(UuidSchema),
});
export type PhotoDetail = z.infer<typeof PhotoDetailSchema>;

export const PhotoListResponseSchema = z.object({
  photos: z.array(PhotoSummarySchema),
  total: z.number().int(),
  offset: z.number().int(),
  limit: z.number().int(),
});
export type PhotoListResponse = z.infer<typeof PhotoListResponseSchema>;

export const ReprocessRequestSchema = PhotoIdListSchema.extend({
  source: ThumbnailSourceSchema,
});
export type ReprocessRequest = z.infer<typeof ReprocessRequestSchema>;

export const PreviewRequestSchema = z.object({ source: ThumbnailSourceSchema });
export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;

export const UpdatePhotoRequestSchema = z.object({
  rating: z.number().int().min(0).max(5).optional(),
  triage: TriageSchema.optional(),
  notes: z.string().optional(),
  // Which rendition this photo was last looked at in, for the viewer setting
  // that reopens it there (§10.2).
  preview_rendition: PreviewRenditionSchema.optional(),
});
export type UpdatePhotoRequest = z.infer<typeof UpdatePhotoRequestSchema>;

// Boolean query params use stringbool() so ?is_missing=false parses as false.
export const PhotoListQuerySchema = PaginationSchema
  .extend(SoftDeleteFilterSchema.shape)
  .extend({
    // Overrides the collection's stored ordering for this request only, so the
    // client can offer a sort control without mutating the library's default.
    ordering: OrderingSchema.optional(),
    // Case-insensitive substring match on file_path: how a photographer looks a
    // frame up, by filename.
    q: z.string().min(1).optional(),
    rated: z.stringbool().optional(),
    // Comma-separated verdicts to include, e.g. `triage=untriaged,picked` for the
    // default gallery view that hides rejects. Omitted means all three.
    triage: z
      .string()
      .transform((s) => s.split(',').map((v) => v.trim()))
      .pipe(z.array(TriageSchema).min(1))
      .optional(),
    is_missing: z.stringbool().optional(),
    needs_processing: z.stringbool().optional(),
    // Selects *only* (or only non-) soft-deleted rows, where include_deleted just
    // widens the default exclusion. `include_deleted=true&is_deleted=true` is the
    // Bin view; without this pair a client can ask for "deleted and live" but
    // never for "deleted alone".
    is_deleted: z.stringbool().optional(),
    // Inclusive YYYY-MM-DD bounds on when the photo was taken.
    taken_from: z.iso.date().optional(),
    taken_to: z.iso.date().optional(),
    // How rated/triage/is_missing/needs_processing combine. 'any' is what makes a
    // custom filter like "picks, unrated or missing" mean a union rather than an
    // intersection, which as an intersection is almost always empty.
    match: z.enum(['all', 'any']).optional(),
  });
export type PhotoListQuery = z.infer<typeof PhotoListQuerySchema>;

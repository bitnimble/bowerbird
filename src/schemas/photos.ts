import { z } from 'zod';
import { OrderingSchema, PaginationSchema, PhotoIdListSchema, RenditionSourceSchema, SoftDeleteFilterSchema, UuidSchema } from './common';
import { ViewerRenditionSchema } from './settings';

// The cull verdict. 'untriaged' is the wire spelling of a NULL column: a photo
// the user has not judged yet, which is the set they most often want to see.
export const TriageSchema = z.enum(['untriaged', 'picked', 'rejected']);
export type Triage = z.infer<typeof TriageSchema>;

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
  // When each derived file was last written, and so which generation of it a URL
  // asks for. On the summary because this is what a client puts in every image
  // URL: they are rebuilt in place under a stable path, and a page holding the
  // previous ones has no other way to know they moved (§13.5). One per stage of
  // the import, because they move at different times and a URL should only move
  // when the file behind it did. Null before that stage has ever run.
  tile_built_at: z.string().nullable(),
  renditions_built_at: z.string().nullable(),
  // When the RAW itself last changed. The camera's JPEG is lifted out of it per
  // request rather than built, so this is the generation of *that* file.
  date_updated: z.string().nullable(),
  // The rendition this photo was last viewed in, read by the setting that
  // reopens it there. On the summary for the same reason as the field above: the
  // viewer has to know which file to ask for before it has fetched anything, or
  // it opens at the library's default and swaps a moment later (§18.5).
  viewer_rendition: ViewerRenditionSchema.nullable(),
});
export type PhotoSummary = z.infer<typeof PhotoSummarySchema>;

export const PhotoDetailSchema = PhotoSummarySchema.extend({
  file_path: z.string(),
  file_hash: z.string().nullable(),
  orientation: z.number().int(),
  date_taken: z.string().nullable(),
  // The zone that capture time was written in, "+11:00". EXIF 2.31 and later, so
  // null from an older body; date_taken stays the camera's wall clock either way
  // (§11.1), and this says what that clock was set to.
  date_taken_offset: z.string().nullable(),
  date_added: z.string(),
  // Which passes this photo still owes: the grid tile the gallery shows, then the
  // viewer's renditions (§10.2). Separate so a view can say which one it is
  // waiting on rather than reporting "rendition building" for both.
  needs_tile: z.boolean(),
  needs_renditions: z.boolean(),
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
  // Which pixels the grid tile was built from; NULL before first processing.
  rendition_source: RenditionSourceSchema.nullable(),
  // Where the bytes actually live on the server, so the detail panel can name the
  // file it is showing. Resolved by the service, which holds the library: null on
  // the repository's own read, and for a photo whose library has gone.
  original_path: z.string().nullable(),
  // What the viewer opens this photo at when nothing has been picked: the camera's
  // JPEG for a library that serves it directly, the full-size rendition otherwise.
  default_rendition: ViewerRenditionSchema,
  // One entry per rendition the viewer can show rather than one for whichever is
  // on screen, because the server does not know which that is and each is a
  // different file. Every field is answered from disk rather than from a column:
  // the file is the cache, so it is the truth, and a library switched to HDR
  // after an import has renditions that predate the setting (§10.2).
  renditions: z
    .record(
      ViewerRenditionSchema,
      z.object({
        path: z.string(),
        built: z.boolean(),
        hdr: z.boolean(),
        // What this file weighs, null when it is not built. Reported here rather
        // than measured off the response in the browser: Firefox leaves the body
        // sizes on a cross-origin resource-timing entry at 0 whatever the
        // response is labelled with, so the panel read "unknown" there.
        bytes: z.number().int().nullable(),
        // The one-frame AV1 twin when it exists, so a client on Firefox knows it
        // may reach for it instead of a still it would render dark (§10.7).
        video: z.object({ path: z.string(), bytes: z.number().int() }).nullable(),
      }),
    )
    .nullable(),
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
  // The ordering this page was built in, which is the collection's stored one
  // unless the request overrode it. Reported so a client never has to hold a
  // guess at what the sort is: it renders the control from what it was served,
  // and there is one copy of the answer (§18.3.1).
  ordering: OrderingSchema,
});
export type PhotoListResponse = z.infer<typeof PhotoListResponseSchema>;

export const UpdatePhotoRequestSchema = z.object({
  rating: z.number().int().min(0).max(5).optional(),
  triage: TriageSchema.optional(),
  notes: z.string().optional(),
  // Which rendition this photo was last looked at in, for the viewer setting
  // that reopens it there (§10.2).
  viewer_rendition: ViewerRenditionSchema.optional(),
});
export type UpdatePhotoRequest = z.infer<typeof UpdatePhotoRequestSchema>;

// Boolean query params use stringbool() so ?is_missing=false parses as false.
export const PhotoListQuerySchema = PaginationSchema
  .extend(SoftDeleteFilterSchema.shape)
  .extend({
    // Overrides the collection's stored ordering for this request only. The web
    // client does not send it - it sorts by editing the collection (§18.3.1), so
    // that the sort is the same on the next device - and this is for a caller
    // that wants one page in a different order without changing anything.
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
    needs_tile: z.stringbool().optional(),
    // Selects *only* (or only non-) soft-deleted rows, where include_deleted just
    // widens the default exclusion. `include_deleted=true&is_deleted=true` is the
    // Bin view; without this pair a client can ask for "deleted and live" but
    // never for "deleted alone".
    is_deleted: z.stringbool().optional(),
    // Inclusive YYYY-MM-DD bounds on when the photo was taken.
    taken_from: z.iso.date().optional(),
    taken_to: z.iso.date().optional(),
    // How rated/triage/is_missing/needs_tile combine. 'any' is what makes a
    // custom filter like "picks, unrated or missing" mean a union rather than an
    // intersection, which as an intersection is almost always empty.
    match: z.enum(['all', 'any']).optional(),
  });
export type PhotoListQuery = z.infer<typeof PhotoListQuerySchema>;

// The same filters as a list query, in JSON rather than in a query string, so a
// body can carry them without the string coercions the URL form needs.
export const PhotoFiltersSchema = z.object({
  include_deleted: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  is_missing: z.boolean().optional(),
  needs_tile: z.boolean().optional(),
  rated: z.boolean().optional(),
  triage: z.array(TriageSchema).min(1).optional(),
  q: z.string().min(1).optional(),
  taken_from: z.iso.date().optional(),
  taken_to: z.iso.date().optional(),
  match: z.enum(['all', 'any']).optional(),
});
export type PhotoFilters = z.infer<typeof PhotoFiltersSchema>;

/**
 * A set of photos named by where they sit in a filtered collection rather than
 * by id (§18.3.3). Both ends of a range are inclusive.
 */
export const PhotoSelectionSchema = z.object({
  // Which collection the positions are into. The bin and the missing view are
  // the library plus a filter, so they need no kind of their own.
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('library'), id: UuidSchema }),
    z.object({ kind: z.literal('shoot'), id: UuidSchema }),
    z.object({ kind: z.literal('album'), id: UuidSchema }),
  ]),
  filters: PhotoFiltersSchema.default({}),
  // No ordering: positions are into the collection's own sort, which the
  // collection answers for and there is exactly one copy of (§18.3.1). A client
  // stating it here could name an order the selection was never made in.
  ranges: z
    .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }))
    .min(1)
    // Bounds the body, not the selection: a run costs one entry however long it
    // is, so this only refuses a pathologically scattered pick.
    .max(10_000)
    // Ascending and disjoint, which is what the client's own representation
    // guarantees. It also bounds the work: overlapping runs could name the same
    // photo any number of times, so ten thousand copies of one whole-library run
    // would resolve to ten thousand times the library's ids.
    .refine((ranges) => ranges.every((range, i) => range.end >= range.start && (i === 0 || range.start > ranges[i - 1]!.end)), {
      message: 'ranges must be ascending, non-overlapping, and end at or after they start',
    }),
});
export type PhotoSelection = z.infer<typeof PhotoSelectionSchema>;

// What a bulk action applies to: a list of ids, or a selection the server
// resolves to ids itself. The second is what lets a client act on more photos
// than it could ever hold the ids for.
export const PhotoTargetSchema = z.union([PhotoIdListSchema, z.object({ selection: PhotoSelectionSchema })]);
export type PhotoTarget = z.infer<typeof PhotoTargetSchema>;

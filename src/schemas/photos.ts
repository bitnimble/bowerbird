import { z } from 'zod';
import { OrderingSchema, PaginationSchema, PhotoIdListSchema, RenditionSourceSchema, SoftDeleteFilterSchema, IdSchema } from './common';
import { ViewerRenditionSchema } from './settings';

// The cull verdict. 'untriaged' is the wire spelling of a NULL column: a photo
// the user has not judged yet, which is the set they most often want to see.
export const TriageSchema = z.enum(['untriaged', 'picked', 'rejected']);
export type Triage = z.infer<typeof TriageSchema>;

export const PhotoSummarySchema = z.object({
  id: IdSchema,
  library_id: IdSchema,
  shoot_id: IdSchema.nullable(),
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
  // The stack this row stands for, and how many photos it stands for (§19.5).
  // A listing is collapsed, so a stacked row is one tile carrying its whole
  // stack; `stack_size` is 1 for an ordinary photo. In library and shoot views
  // the count is the stack's full membership, in an album view only the members
  // that album holds, because an album is strict about what is in it.
  stack_id: IdSchema.nullable(),
  stack_size: z.number().int().positive(),
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
  // Body and lens, off the RAW header. Null when the camera recorded nothing
  // (fixed-lens bodies report no lens).
  camera_make: z.string().nullable(),
  camera_model: z.string().nullable(),
  lens_model: z.string().nullable(),
  // Which pixels the viewer's renditions were built from; NULL until they land.
  rendition_source: RenditionSourceSchema.nullable(),
  // Where the bytes actually live on the server, so the detail panel can name the
  // file it is showing. Resolved by the service, which holds the library: null on
  // the repository's own read, and for a photo whose library has gone.
  original_path: z.string().nullable(),
  // What the viewer opens this photo at when nothing has been picked: the camera's
  // JPEG for a library that serves it directly, the full-size rendition otherwise -
  // and always the rendition once the photo has been edited, because the camera's
  // own JPEG cannot carry an edit.
  default_rendition: ViewerRenditionSchema,
  // Whether this photo has develop settings stored. What it decides here is the line
  // above; a client can also use it to say so, since "edited" is not otherwise
  // visible from a picture that has been edited well.
  is_edited: z.boolean(),
  // What the photo *looks* like once its crop, straighten and rotation are applied.
  // Equal to `width`/`height` for anything uncropped, which is almost everything.
  //
  // Separate from those rather than replacing them, because they answer different
  // questions: `width` is the file, and a caller that wants to know what the camera
  // recorded still needs it. The grid lays out on the pair below - a cropped photo
  // occupies a different shape on the wall, and a tile at the file's aspect would be
  // letterboxed for the life of the library.
  display_width: z.number().int().positive(),
  display_height: z.number().int().positive(),
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
      }),
    )
    .nullable(),
  // Albums this photo belongs to. On the detail only: it needs a second query,
  // and a grid of 100 tiles has no use for it.
  album_ids: z.array(IdSchema),
});
export type PhotoDetail = z.infer<typeof PhotoDetailSchema>;

export const PhotoListResponseSchema = z.object({
  photos: z.array(PhotoSummarySchema),
  // How many match, or absent when the request said not to count (`count=false`).
  // Counting is the expensive half of a listing - no ordering index can cover it,
  // because the filter chips vary - and it cannot change while a client is
  // scrolling one collection, so only the first request of a pass pays for it
  // (§18.3.2).
  total: z.number().int().optional(),
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
    // Whether to answer with the total. Counted unless this says otherwise, so a
    // caller that wants one page and its size asks for nothing special; a client
    // walking a collection block by block turns it off after the first, because
    // the count is a scan no ordering index covers and the answer cannot move
    // underneath it.
    count: z.stringbool().optional(),
    // Every photograph of a stack as a row of its own, rather than the stack as
    // one row (§19.5.4). Must be carried by every question about the same
    // listing - a selection, a position lookup - or a position means one
    // photograph to the client and another here.
    expand_stacks: z.stringbool().optional(),
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
  expand_stacks: z.boolean().optional(),
});
export type PhotoFilters = z.infer<typeof PhotoFiltersSchema>;

/**
 * A set of photos named by where they sit in a filtered collection rather than
 * by id (§18.3.3). Both ends of a range are inclusive.
 */
const PhotoSelectionFields = z.object({
  // Which collection the positions are into. The bin and the missing view are
  // the library plus a filter, so they need no kind of their own.
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('library'), id: IdSchema }),
    z.object({ kind: z.literal('shoot'), id: IdSchema }),
    z.object({ kind: z.literal('album'), id: IdSchema }),
  ]),
  filters: PhotoFiltersSchema.default({}),
  // No ordering: positions are into the collection's own sort, which the
  // collection answers for and there is exactly one copy of (§18.3.1). A client
  // stating it here could name an order the selection was never made in.
  ranges: z
    .array(z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }))
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
  // Photos picked out of an open stack. A collapsed listing gives a member no
  // position of its own (§19.6.1), so these travel by id beside the runs rather
  // than as a selection of their own - one selection covers both, and one action
  // reaches everything the reader has chosen.
  members: z.array(IdSchema).max(1000).default([]),
});

export const PhotoSelectionSchema = PhotoSelectionFields.refine(
  (selection) => selection.ranges.length > 0 || selection.members.length > 0,
  { message: 'a selection names at least one range or one member' },
);
export type PhotoSelection = z.infer<typeof PhotoSelectionSchema>;

// What a bulk action applies to: a list of ids, a selection the server resolves
// to ids itself, or one past bin named by the id the client stamped it with. The
// last two are what let a client act on more photos than it could ever hold the
// ids for - the second going in, the third coming back out (§12.3).
export const PhotoTargetSchema = z.union([
  PhotoIdListSchema,
  z.object({ selection: PhotoSelectionSchema }),
  z.object({ batch: IdSchema }),
]);
export type PhotoTarget = z.infer<typeof PhotoTargetSchema>;

// Where given rows sit in a collection now (§19.6.1). Same scope and filters as
// a selection, because it is the same listing being asked about; a key is a photo
// id or a stack id, and the answer is every position that key names - one for a
// row of a collapsed listing, one per member for a stack in an uncollapsed one
// (§19.5.4). Bounded above what a client can hold rows for, which is what it can
// name keys from.
export const PhotoPositionsRequestSchema = z.object({
  scope: PhotoSelectionFields.shape.scope,
  filters: PhotoFiltersSchema.default({}),
  keys: z.array(z.string()).min(1).max(4000),
});
export type PhotoPositionsRequest = z.infer<typeof PhotoPositionsRequestSchema>;

// The photographs either side of one, in the collection's order with the collapse
// taken off (§19.5.3): a stack is one tile in the grid, and stepping through the
// viewer visits every frame of it. The same scope and filters a position lookup
// takes, because it is the same listing being asked about - only uncollapsed. No
// ordering, for the reason a selection states none: the collection owns it.
export const PhotoNeighboursRequestSchema = z.object({
  scope: PhotoSelectionFields.shape.scope,
  filters: PhotoFiltersSchema.default({}),
  photo_id: IdSchema,
  // Per side. A window rather than a single step, because the query costs the
  // same either way and a reader holding an arrow key must not outrun it.
  limit: z.number().int().min(1).max(100).default(50),
});
export type PhotoNeighboursRequest = z.infer<typeof PhotoNeighboursRequestSchema>;

// The same listing, asked for by its ends. A caller that already knows what sits
// either side of a run - the photographs a stack lies between - gets the run
// itself without having to know the collection's ordering, or which end of it is
// "after". Either bound may be null for that end of the collection.
export const PhotoRangeRequestSchema = z.object({
  scope: PhotoSelectionFields.shape.scope,
  filters: PhotoFiltersSchema.default({}),
  from: IdSchema.nullable().default(null),
  to: IdSchema.nullable().default(null),
});
export type PhotoRangeRequest = z.infer<typeof PhotoRangeRequestSchema>;

// A bin also carries the id to stamp the rows it takes with, so its undo can
// name the operation. Generated by the client, so the undo survives an answer
// that never arrives.
export const DeletePhotosRequestSchema = z.object({ batch: IdSchema.optional() });

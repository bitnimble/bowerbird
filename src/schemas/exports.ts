import { z } from 'zod';
import { EditDocSchema } from './photo_edits';

// What was taken out of the library, kept after the fact (§10.5.1).
//
// **What the export was is a copy; what the photograph is is a lookup.** Moving a slider and
// exporting again has to list two exports carrying the settings each was written with, and a
// row that read the photograph's current edits would show the second's under both. Which
// library holds it and which shoot it sits in are not facts about the export at all, so they
// are read off the photograph and follow it.

/**
 * Where a file landed, which is all the client owes the history: the render wrote the row,
 * tile and all, and only the client knows the destination.
 */
export const RecordExportRequestSchema = z.object({
  /** The run this file belongs to, minted by the client. A single export is a run of one. */
  run_id: z.string().min(1),
  photo_id: z.string().min(1),
  output_path: z.string().min(1),
});
export type RecordExportRequest = z.infer<typeof RecordExportRequestSchema>;

export const ExportedPhotoSchema = z.object({
  id: z.string(),
  photo_id: z.string(),
  /**
   * Where the photograph lives now, read off it rather than stored: a photograph moved
   * between shoots reads under the one holding it. Null once it has left the catalogue, which
   * the row itself survives.
   */
  library_id: z.string().nullable(),
  library_name: z.string().nullable(),
  /** The shoot holding it, by folder path, or null where none does. */
  shoot_id: z.string().nullable(),
  shoot_name: z.string().nullable(),
  source_path: z.string(),
  output_path: z.string(),
  /** The settings this file was written with, or null where it was written without them. */
  edits: EditDocSchema.nullable(),
  /** The photograph's own size, which a crop in `edits` is a fraction of. Null once it has gone. */
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** False where the render could not be made, e.g. the RAW had gone by the time it was asked for. */
  has_thumbnail: z.boolean(),
  exported_at: z.string(),
});
export type ExportedPhoto = z.infer<typeof ExportedPhotoSchema>;

export const ExportRunSchema = z.object({
  id: z.string(),
  exported_at: z.string(),
  photos: z.array(ExportedPhotoSchema),
});
export type ExportRun = z.infer<typeof ExportRunSchema>;

export const ExportRunsSchema = z.array(ExportRunSchema);

/**
 * What a run that has not been written yet is about, so a queued export reads as the same row
 * the history will hold for it.
 *
 * `include_edits` because a pending row lists the settings the file *will* carry, which is the
 * photograph's current ones only where the run was asked to take them.
 */
export const QueuedExportsRequestSchema = z.object({
  photo_ids: z.array(z.string().min(1)),
  include_edits: z.boolean(),
});
export type QueuedExportsRequest = z.infer<typeof QueuedExportsRequestSchema>;

/**
 * How far through one photograph of a run the render is, announced while it runs (§10.5).
 *
 * A run's own progress is the client's - it holds the queue and writes each file - but a
 * photograph is minutes inside one request, and a bar that only counts files sits at nothing for
 * the whole of a single-photograph export.
 */
export const ExportProgressSchema = z.object({
  run_id: z.string(),
  photo_id: z.string(),
  /** 0 to 1 through this photograph. */
  fraction: z.number(),
});
export type ExportProgress = z.infer<typeof ExportProgressSchema>;

/** The photograph as it stands, in the shape the history states one in. */
export const QueuedPhotoSchema = z.object({
  photo_id: z.string(),
  library_id: z.string().nullable(),
  library_name: z.string().nullable(),
  shoot_id: z.string().nullable(),
  shoot_name: z.string().nullable(),
  source_path: z.string(),
  edits: EditDocSchema.nullable(),
  width: z.number(),
  height: z.number(),
  /** Which generation of the grid tile to ask for; null before one was built. */
  tile_built_at: z.string().nullable(),
});
export type QueuedPhoto = z.infer<typeof QueuedPhotoSchema>;

export const QueuedPhotosSchema = z.array(QueuedPhotoSchema);

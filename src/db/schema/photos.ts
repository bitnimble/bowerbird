import { desc, sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { RENDITION_SOURCES } from '../../schemas/common';
import { oneOf } from './checks';
import { libraries } from './libraries';
import { shoots } from './shoots';
import { stacks } from './stacks';

export const TRIAGE_VERDICTS = ['picked', 'rejected'] as const;
export const STACK_STATES = ['none', 'stacked', 'unstacked'] as const;

export const photos = sqliteTable(
  'photos',
  {
    id: text('id').primaryKey(),
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    shootId: text('shoot_id').references(() => shoots.id, { onDelete: 'set null' }),
    fileHash: text('file_hash'),
    // Written at import and never again: every later write of a path is a folder rename, a bin
    // move or a restore, none of which changes a filename's extension.
    format: text('format'),
    fileSize: integer('file_size'), // bytes at last scan; with date_updated, the stat quick-check (§9.1)
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    orientation: integer('orientation').notNull().default(0),
    isMissing: integer('is_missing').notNull().default(0),
    isDeleted: integer('is_deleted').notNull().default(0),
    // Kept out of every listing but the one that asks for it, and out of every queue (§12.4). A
    // shoot carries the same flag, and a photograph under a hidden one is hidden without this being
    // written: hiding is undone by unhiding the same thing that was hidden.
    isHidden: integer('is_hidden').notNull().default(0),
    dateTaken: text('date_taken'), // the camera's wall clock, stored as a Z string (§4, §11.1)
    dateTakenOffset: text('date_taken_offset'), // its UTC offset, "+11:00", where the body recorded one
    dateAdded: text('date_added').notNull(),
    dateUpdated: text('date_updated'),
    processingError: text('processing_error'),
    latitude: real('latitude'),
    longitude: real('longitude'),
    iso: integer('iso'), // shooting metadata, read from the RAW header (§11.1)
    shutterSpeed: real('shutter_speed'), // seconds; 1/250s is stored as 0.004
    aperture: real('aperture'), // f-number
    focalLength: real('focal_length'), // mm
    cameraMake: text('camera_make'),
    cameraModel: text('camera_model'),
    lensModel: text('lens_model'),
    deletedFromPath: text('deleted_from_path'), // file_path before the Bin move, so restore can put it back (§12.3)
    deletedBatch: text('deleted_batch'), // which bin took it, so an undo names the operation not every id (§12.3)
    rating: integer('rating').notNull().default(0),
    // NULL means untriaged, which is a real third state: "not yet judged" is what a photographer
    // filters on, and a boolean cannot say it.
    triage: text('triage'),
    notes: text('notes'),
    // Which pixels the *viewer's* renditions were built from (§10.2). Not the grid tile's: a tile
    // is requested as the embedded JPEG whatever the library says, and recording that here would
    // tell the next import there are no renditions to build.
    renditionSource: text('rendition_source'),
    // How this row's pixels are arrived at, and what from (RecipeSchema). A synthesised row
    // composes other rows and names no file of its own.
    //
    // The path lives in here rather than in a column beside it: a row is not one file, it is a
    // recipe over a list of them, and a column can only hold the first. photo_inputs is that list,
    // unpacked for the queries that have to be indexed.
    recipe: text('recipe').notNull(),
    viewerRendition: text('viewer_rendition'),
    stackId: text('stack_id').references(() => stacks.id, { onDelete: 'set null' }),
    stackState: text('stack_state').notNull().default('none'),
    descriptor: blob('descriptor'),
    isRepresentative: integer('is_representative').notNull().default(1),
    stampImported: text('stamp_imported'),
    stampTriage: text('stamp_triage'),
    stampPlacement: text('stamp_placement'),
    stampBin: text('stamp_bin'),
    stampStack: text('stamp_stack'),
    stampHidden: text('stamp_hidden'),
    contentHash: text('content_hash'),
    // When this device last wanted the original itself - a decode, an export, a look at the photo
    // in the viewer, an edit - which is the order the cull gives copies back in (§14.5). Local and
    // unstamped: which photos this laptop has been working on is not a fact about the photograph.
    lastAccessedAt: text('last_accessed_at'),
  },
  (t) => [
    check('photos_rating', sql`${t.rating} >= 0 AND ${t.rating} <= 5`),
    check('photos_triage', oneOf(t.triage, TRIAGE_VERDICTS)),
    check('photos_rendition_source', oneOf(t.renditionSource, RENDITION_SOURCES)),
    check('photos_stack_state', oneOf(t.stackState, STACK_STATES)),

    index('idx_photos_library').on(t.libraryId),
    index('idx_photos_shoot').on(t.shootId),
    // The gallery's four orderings, keyed exactly as ORDER BY spells them (orderByClause, §8.2):
    // the id tiebreak that makes paging a total order is part of the key, and the taken_* pair
    // leads with the NULL-last expression. Without the tiebreak in the index SQLite sorts the
    // whole library into a temp b-tree on every request (§18.3.2).
    //
    // is_deleted sits ahead of the sort columns because every listing filters on it, so the rows a
    // deep OFFSET skips are skipped inside the index rather than probed in the table.
    index('idx_photos_library_order_added').on(t.libraryId, t.isDeleted, t.dateAdded, t.id),
    index('idx_photos_library_order_taken').on(
      t.libraryId,
      t.isDeleted,
      sql`(${t.dateTaken} IS NULL)`,
      t.dateTaken,
      t.id,
    ),
    index('idx_photos_shoot_order_added').on(t.shootId, t.isDeleted, t.dateAdded, t.id),
    index('idx_photos_shoot_order_taken').on(
      t.shootId,
      t.isDeleted,
      sql`(${t.dateTaken} IS NULL)`,
      t.dateTaken,
      t.id,
    ),
    // The added_* pair is one index read forwards or backwards, but taken_desc is not: NULLs stay
    // last while the dates reverse, so its key is the only one that genuinely differs by direction.
    index('idx_photos_library_order_taken_desc').on(
      t.libraryId,
      t.isDeleted,
      sql`(${t.dateTaken} IS NULL)`,
      desc(t.dateTaken),
      desc(t.id),
    ),
    index('idx_photos_shoot_order_taken_desc').on(
      t.shootId,
      t.isDeleted,
      sql`(${t.dateTaken} IS NULL)`,
      desc(t.dateTaken),
      desc(t.id),
    ),
    index('idx_photos_file_hash').on(t.libraryId, t.fileHash),
    index('idx_photos_is_missing').on(t.libraryId, t.isMissing).where(sql`${t.isMissing} = 1`),
    index('idx_photos_is_deleted').on(t.libraryId, t.isDeleted).where(sql`${t.isDeleted} = 1`),
    index('idx_photos_is_hidden').on(t.libraryId, t.isHidden).where(sql`${t.isHidden} = 1`),
    index('idx_photos_deleted_batch')
      .on(t.deletedBatch)
      .where(sql`${t.deletedBatch} IS NOT NULL`),
    index('idx_photos_stack').on(t.stackId),
    index('idx_photos_stack_candidates').on(
      t.libraryId,
      t.stackState,
      t.dateTaken,
      t.dateAdded,
      t.id,
    ),
    uniqueIndex('idx_photos_one_representative')
      .on(t.stackId)
      .where(sql`${t.stackId} IS NOT NULL AND ${t.isRepresentative} = 1`),
  ],
);

// Which files each photograph is composed from: inputsOf(recipe), one row per entry, and nothing a
// recipe does not already say.
//
// Derived, and so replicated by nothing. The recipe is the truth and travels as part of
// photo.placement; this is the index that makes it answerable in both directions: the folder range
// scans and path lookups a scan does, and the reverse edge that matters more, which is, given a
// file that changed on disk, which photographs are now stale.
//
// Maintained by the database rather than by whoever writes the row (photoInputTriggers): a recipe
// is written from a dozen places, and an index the writer has to remember is one that drifts the
// first time somebody forgets.
export const photoInputs = sqliteTable(
  'photo_inputs',
  {
    libraryId: text('library_id').notNull(),
    photoId: text('photo_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.photoId, t.path] }),
    // The scan's direction: a path, to the photographs it feeds. Leading with the library because
    // every question about a path is asked inside one, and the range scans that walk a folder
    // (path >= ? AND path < ?) are this index read as a range.
    index('idx_photo_inputs_path').on(t.libraryId, t.path),
  ],
);

// Which photographs each composed row is made of: sourcesOf(recipe), one row per frame, and the
// other half of the dependency graph photo_inputs holds the file end of.
//
// Only composed_id is a foreign key. A frame is named by the recipe, and a recipe can reach a peer
// before the photographs it names do, since replication carries rows in stamp order rather than in
// dependency order. Requiring the frame to exist would reject the composite outright and the
// panorama would never land at all. photos_forget_inputs clears an edge when a frame is deleted,
// since there is no key here to cascade one.
export const photoSources = sqliteTable(
  'photo_sources',
  {
    libraryId: text('library_id').notNull(),
    composedId: text('composed_id')
      .notNull()
      .references(() => photos.id, { onDelete: 'cascade' }),
    photoId: text('photo_id').notNull(),
    // Where this frame sits in the recipe, so a band shows them as the pan was shot.
    at: integer('at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.composedId, t.photoId] }),
    // The hiding direction: given a photograph, is anything composed from it.
    index('idx_photo_sources_photo').on(t.photoId),
  ],
);

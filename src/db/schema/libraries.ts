import { check, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { OrderingSchema, RENDITION_SOURCES } from '../../schemas/common';
import { RENDERED_RENDITIONS } from '../../schemas/render_stages';
import { oneOf } from './checks';

export const libraries = sqliteTable(
  'libraries',
  {
    id: text('id').primaryKey(),
    rootPath: text('root_path').notNull().unique(),
    // Always set: create stores the folder name (or parent + year) when none is given, rather
    // than leaving a placeholder.
    name: text('name').notNull(),
    lastSyncedAt: text('last_synced_at'),
    ordering: text('ordering').notNull().default('taken_asc'),
    // Per library rather than global: one catalogue may be scanned JPEGs where the camera's
    // rendering is the point, another RAWs worth demosaicing. 'render' is the picture the RAW
    // actually holds, so it is the default.
    renditionSource: text('rendition_source').notNull().default('render'),
    // Only meaningful with 'render': an embedded JPEG is 8-bit SDR, so there is no headroom in
    // it to carry.
    renditionHdr: integer('rendition_hdr').notNull().default(1),
    // Standing rules, not import-time choices: a folder created next month is in or out for the
    // same reason today's are.
    includeSubfolders: integer('include_subfolders').notNull().default(1),
    // Off by default: the JPEGs beside a folder of RAWs are usually the camera's own duplicates
    // of frames the library already holds, and importing both makes every one of them two rows.
    includeNonRaw: integer('include_non_raw').notNull().default(0),
    // NULL means this library has no bin: nothing on disk records a binning, so is_deleted is
    // the only truth. Nullable rather than '' because joining '' onto the root gives the root,
    // which would point the bin channel at the whole library.
    binName: text('bin_name'),
    // The app writes nothing under root_path. read_only = 0 with a NULL bin_name never persists.
    readOnly: integer('read_only').notNull().default(0),
    // The bin folder's identity, recorded when the folder is made, so a hand-rename of it is
    // followed rather than read as the whole bin being restored.
    binDev: integer('bin_dev'),
    binIno: integer('bin_ino'),
    binBirthtime: real('bin_birthtime'),
    // Which stages a `full` or a `max` render leaves out, comma-separated and empty for none
    // (`schemas/render_stages.ts`). One column per rendition, because the query that carries
    // these onto a pending row picks the one it needs by name.
    renderSkipFull: text('render_skip_full').notNull().default(''),
    renderSkipMax: text('render_skip_max').notNull().default(''),
    autoStack: integer('auto_stack').notNull().default(1),
    autoStackSimilarity: real('auto_stack_similarity').notNull().default(0.78),
    autoStackWindowSeconds: integer('auto_stack_window_seconds').notNull().default(60),
    stamp: text('stamp'),
  },
  (t) => [
    check('libraries_ordering', oneOf(t.ordering, OrderingSchema.options)),
    check('libraries_rendition_source', oneOf(t.renditionSource, RENDITION_SOURCES)),
  ],
);

// What a render of this library's photographs was measured to cost here, stage by stage (§10.1).
//
// A table rather than a field on `libraries`, and emphatically not a blob in `settings`: it is
// written by a benchmark that takes minutes, so two of them overlapping would otherwise be a
// read-modify-write race over one shared value. Keyed on the pair, so each writes its own row and
// neither can drop the other's. Not replicated - a measurement describes this machine's hardware,
// and a peer's numbers would be someone else's - and cascaded away with the library, which a
// settings blob would have leaked forever.
export const renderTimings = sqliteTable(
  'render_timings',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    rendition: text('rendition').notNull(),
    totalMs: real('total_ms').notNull(),
    // `{ stage: ms }`, this row's own payload rather than anything queried across.
    stagesMs: text('stages_ms').notNull(),
    measuredAt: text('measured_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.rendition] }),
    check('render_timings_rendition', oneOf(t.rendition, RENDERED_RENDITIONS)),
  ],
);

// "This library is syncing", as a leased row rather than a file at the library root (§9.7). It
// guards the catalogue rather than the tree, so it belongs in the catalogue, and a timestamp means
// the same thing in every PID namespace where the file lock's owner PID did not. A row present at
// startup means "stale within the lease", not "syncing", so nothing deletes these on the way up.
export const syncLocks = sqliteTable('sync_locks', {
  libraryId: text('library_id')
    .primaryKey()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  owner: text('owner').notNull(), // one per acquire rather than per process
  startedAt: text('started_at').notNull(), // toISOString(), UTC, which is what makes the comparison valid
  refreshedAt: text('refreshed_at').notNull(),
});

// Where a folder differs from what the library's settings say in general (§4.7). 'excluded' keeps
// it out of the scan entirely; 'plain' lets its photos in but keeps mirroring from making it a
// shoot, which is what lets "delete the shoot, keep the photos" survive the next sync. One row per
// folder: both answer the same question about it, so the second write replaces the first.
export const FOLDER_RULES = ['excluded', 'plain'] as const;

export const folderRules = sqliteTable(
  'folder_rules',
  {
    libraryId: text('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    folderPath: text('folder_path').notNull(),
    rule: text('rule').notNull(),
    stamp: text('stamp'),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.folderPath] }),
    check('folder_rules_rule', oneOf(t.rule, FOLDER_RULES)),
  ],
);

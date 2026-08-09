import type { Database } from 'bun:sqlite';
import { DEFAULT_SETTINGS } from '../schemas/settings';
import { inferredLibraryName } from '../utils/library_name';

// Schema creation. Tables are ordered so every REFERENCES target already exists.
// Idempotent (IF NOT EXISTS) so it is safe to run on every startup. See DESIGN §4.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS libraries (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  -- What the library is called in the UI. Always set: create stores the folder
  -- name (or parent + year) when none is given, rather than leaving a placeholder.
  name        TEXT NOT NULL,
  last_synced_at TEXT,          -- ISO datetime of the last completed sync; NULL if never synced
  ordering    TEXT NOT NULL DEFAULT 'taken_asc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  -- Where this library's renditions get their pixels, and whether the full-size
  -- one is HDR (§10.2). Per library rather than global: one catalogue may be
  -- scanned JPEGs where the camera's rendering is the point, another RAWs worth
  -- demosaicing. 'embedded' is the default because it needs no demosaic.
  rendition_source TEXT NOT NULL DEFAULT 'embedded'
    CHECK (rendition_source IN ('embedded', 'render')),
  -- Only meaningful with 'render': an embedded JPEG is 8-bit SDR, so there is no
  -- headroom in it to carry.
  rendition_hdr INTEGER NOT NULL DEFAULT 0,
  -- How much of the folder tree this library is, and whether its folders are
  -- shoots (§4.1). Standing rules, not import-time choices: a folder created
  -- next month is in or out for the same reason today's are.
  include_subfolders INTEGER NOT NULL DEFAULT 1,
  mirror_shoots      INTEGER NOT NULL DEFAULT 1,
  -- The folder soft-deleted RAWs are moved into, and the folder name the scan
  -- skips everywhere (§12.3). Per library because it is chosen against the root's
  -- existing contents: a root already holding a 'Bin' of the user's own gets a
  -- different name rather than having that folder quietly excluded.
  --
  -- NULL means this library has no bin: nothing on disk records a binning, so
  -- is_deleted is the only truth. Nullable rather than '' because joining '' onto
  -- the root gives the root, which would point the bin channel at the whole
  -- library.
  bin_name    TEXT,
  -- The app writes nothing under root_path. read_only = 0 with a NULL bin_name
  -- never persists.
  read_only   INTEGER NOT NULL DEFAULT 0,
  -- The bin folder's identity, recorded when the folder is made, so a hand-rename
  -- of it is followed rather than read as the whole bin being restored.
  bin_dev       INTEGER,
  bin_ino       INTEGER,
  bin_birthtime REAL
);

-- "This library is syncing", as a leased row rather than a file at the library
-- root (§9.7). It guards the catalogue rather than the tree, so it belongs in the
-- catalogue, and a timestamp means the same thing in every PID namespace where
-- the file lock's owner PID did not (§9.7). A row present at startup means
-- "stale within the lease", not "syncing": a crashed process leaves its row and
-- expiry clears it, so nothing deletes these on the way up.
CREATE TABLE IF NOT EXISTS sync_locks (
  library_id    TEXT PRIMARY KEY REFERENCES libraries(id) ON DELETE CASCADE,
  owner         TEXT NOT NULL,   -- UUID, one per acquire rather than per process
  started_at    TEXT NOT NULL,   -- toISOString(), UTC, which is what makes the comparison valid
  refreshed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shoots (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES shoots(id) ON DELETE CASCADE,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path   TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  ordering      TEXT NOT NULL DEFAULT 'taken_asc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  -- The folder's identity apart from its path, so a rename on disk is recognised
  -- rather than read as a delete plus a create (§9.4.1). NULL until first seen.
  -- The device is half the key: inode numbers are only unique within one
  -- filesystem, and a library with a second volume mounted inside it would
  -- otherwise match a shoot against an unrelated folder.
  folder_dev        INTEGER,
  folder_ino        INTEGER,
  folder_birthtime  REAL,
  -- A shoot is its folder; the name is a label on it. Two shoots in one folder is
  -- the collision worth refusing, and it is this one stated directly.
  UNIQUE (library_id, folder_path)
);
CREATE INDEX IF NOT EXISTS idx_shoots_library ON shoots(library_id);
CREATE INDEX IF NOT EXISTS idx_shoots_parent ON shoots(parent_id);

CREATE TABLE IF NOT EXISTS photos (
  id                TEXT PRIMARY KEY,
  library_id        TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  shoot_id          TEXT REFERENCES shoots(id) ON DELETE SET NULL,
  file_hash         TEXT,
  file_path         TEXT NOT NULL,
  file_size         INTEGER,        -- bytes at last scan; with date_updated, the stat quick-check (§9.1)
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  orientation       INTEGER NOT NULL DEFAULT 0,
  is_missing        INTEGER NOT NULL DEFAULT 0,
  is_deleted        INTEGER NOT NULL DEFAULT 0,
  date_taken        TEXT,           -- the camera's wall clock, stored as a Z string (§4, §11.1)
  date_taken_offset TEXT,           -- its UTC offset, "+11:00", where the body recorded one
  date_added        TEXT NOT NULL,
  date_updated      TEXT,
  -- An import runs in two passes, and everything from the queue's own bookkeeping
  -- to a client's cache keys has to tell them apart (§10.2). The grid tile is
  -- written first and is what the gallery shows; the viewer's renditions follow,
  -- ~1.5s later per photo. A pending flag and a written-at stamp each, so a run
  -- interrupted between the passes resumes at the one it did not reach, and a URL
  -- moves only when the file behind it did.
  needs_tile        INTEGER NOT NULL DEFAULT 1,
  needs_renditions  INTEGER NOT NULL DEFAULT 1,
  tile_built_at     TEXT,
  renditions_built_at TEXT,
  processing_error  TEXT,
  latitude          REAL,
  longitude         REAL,
  iso               INTEGER,        -- shooting metadata, read from the RAW header (§11.1)
  shutter_speed     REAL,           -- seconds; 1/250s is stored as 0.004
  aperture          REAL,           -- f-number
  focal_length      REAL,           -- mm
  camera_make       TEXT,
  camera_model      TEXT,
  lens_model        TEXT,
  deleted_from_path TEXT,           -- file_path before the Bin move, so restore can put it back (§12.3)
  deleted_batch     TEXT,           -- which bin took it, so an undo names the operation not every id (§12.3)
  rating            INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  -- Cull verdict. NULL means untriaged, which is a real third state: "not yet
  -- judged" is what a photographer filters on, and a boolean cannot say it.
  triage            TEXT CHECK (triage IN ('picked', 'rejected')),
  notes             TEXT,
  -- Which pixels the *viewer's* renditions were built from (§10.2), written when
  -- they land and cleared when they are invalidated. Not the grid tile's: that is
  -- always the embedded JPEG whatever the library says, and recording it here
  -- would tell the next import there are no renditions to build.
  rendition_source  TEXT CHECK (rendition_source IN ('embedded', 'render'))
);
CREATE INDEX IF NOT EXISTS idx_photos_library ON photos(library_id);
CREATE INDEX IF NOT EXISTS idx_photos_shoot ON photos(shoot_id);
-- The gallery's four orderings, keyed exactly as ORDER BY spells them
-- (orderByClause, §8.2): the id tiebreak that makes paging a total order is part
-- of the key, and the taken_* pair leads with the NULL-last expression. Without
-- the tiebreak in the index SQLite sorts the whole library into a temp b-tree on
-- every request - which a pager hid behind a click, and a scroll asking for ten
-- thousand blocks does not (§18.3.2).
--
-- is_deleted sits ahead of the sort columns because every listing filters on it,
-- so the rows a deep OFFSET skips are skipped inside the index rather than
-- probed in the table. Named apart from the pairs they replace so an existing
-- catalogue rebuilds rather than keeping a definition that no longer matches.
CREATE INDEX IF NOT EXISTS idx_photos_library_order_added ON photos(library_id, is_deleted, date_added, id);
CREATE INDEX IF NOT EXISTS idx_photos_library_order_taken
  ON photos(library_id, is_deleted, (date_taken IS NULL), date_taken, id);
CREATE INDEX IF NOT EXISTS idx_photos_shoot_order_added ON photos(shoot_id, is_deleted, date_added, id);
CREATE INDEX IF NOT EXISTS idx_photos_shoot_order_taken
  ON photos(shoot_id, is_deleted, (date_taken IS NULL), date_taken, id);
-- The added_* pair is one index read forwards or backwards, but taken_desc is
-- not: NULLs stay last while the dates reverse, so its key is the only one that
-- genuinely differs by direction and the only one that needs a twin. "Newest
-- first" is the default a photographer reaches for, so it is worth the write.
CREATE INDEX IF NOT EXISTS idx_photos_library_order_taken_desc
  ON photos(library_id, is_deleted, (date_taken IS NULL), date_taken DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_shoot_order_taken_desc
  ON photos(shoot_id, is_deleted, (date_taken IS NULL), date_taken DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(library_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_photos_file_path ON photos(library_id, file_path);
CREATE INDEX IF NOT EXISTS idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX IF NOT EXISTS idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;

CREATE TABLE IF NOT EXISTS albums (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  ordering        TEXT NOT NULL DEFAULT 'taken_asc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
);

CREATE TABLE IF NOT EXISTS album_photos (
  album_id    TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id    TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  date_added  TEXT NOT NULL,
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos(photo_id);

CREATE TABLE IF NOT EXISTS shoot_banners (
  shoot_id  TEXT PRIMARY KEY REFERENCES shoots(id) ON DELETE CASCADE,
  photo_id  TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shoot_banners_photo ON shoot_banners(photo_id);

CREATE TABLE IF NOT EXISTS album_banners (
  album_id  TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  photo_id  TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_album_banners_photo ON album_banners(photo_id);

-- Where a folder differs from what the library's settings say in general (§4.7).
-- 'excluded' keeps it out of the scan entirely; 'plain' lets its photos in but
-- keeps mirroring from making it a shoot, which is what lets "delete the shoot,
-- keep the photos" survive the next sync. One row per folder: both answer the
-- same question about it, so the second write replaces the first.
CREATE TABLE IF NOT EXISTS folder_rules (
  library_id   TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path  TEXT NOT NULL,
  rule         TEXT NOT NULL CHECK (rule IN ('excluded', 'plain')),
  PRIMARY KEY (library_id, folder_path)
);

-- A group of photographs of one shot: a burst, or several takes of a scene
-- (§19). Library-wide, so a stack transcends the shoots and albums its members
-- happen to sit in.
--
-- The origin column is load-bearing rather than informational. Detection re-runs
-- over already-stacked photos so that changing the threshold re-forms stacks,
-- and without it that pass would dissolve a manual stack whose members are not
-- alike - two lenses on one subject, which is the case manual stacking exists
-- for. A human touching a stack makes it 'manual' and detection lets it be.
CREATE TABLE IF NOT EXISTS stacks (
  id            TEXT PRIMARY KEY,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  origin        TEXT NOT NULL CHECK (origin IN ('auto', 'manual')),
  date_created  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stacks_library ON stacks(library_id);

-- Runtime settings the user can change from the app, as opposed to the
-- deployment config in environment variables (§15).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- One photo's develop settings as they stand, plus the two small values that move
-- on every undo. Read by the editor's open, and never by way of the history: that
-- split is the whole reason there are two tables.
--
-- Nothing on the render side reads this yet. Applying an edit to a rendition waits
-- on the render pipeline's own rework, which changes where it would be applied;
-- until then an edit is stored and reloaded and changes no pixels.
--
-- Editing is non-destructive: the RAW is never written, and deleting these rows
-- restores the photo to what the camera recorded. The cascade is a *hard* delete
-- only, which is deliberate - a photo restored from the Bin comes back edited, and
-- one whose file moved keeps its edits, because move detection preserves the id.
--
-- No row until the first edit, so an untouched library pays nothing for this.
CREATE TABLE IF NOT EXISTS photo_edits (
  photo_id   TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  doc        TEXT NOT NULL,      -- EditDocSchema, JSON
  -- How far into photo_edit_history.deltas the undo cursor stands. Entries beyond
  -- it are the redo tail, dropped only when a new edit lands. Here rather than
  -- beside the deltas because an undo moves this and the doc and touches neither
  -- the array nor its overflow pages; welded to that blob, stepping one integer
  -- would rewrite tens of kilobytes.
  cursor     INTEGER NOT NULL,
  -- Bumped by every write, and required by the next one. Without it two tabs do
  -- not merely lose an edit: the server diffs a stale document against the stored
  -- one and invents a delta for a change nobody made, which undo then walks back
  -- through.
  rev        INTEGER NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- The undo stack, as one JSON array per photo rather than a row per step. A row
-- per delta would be ~72 bytes of repeated UUID each, in the table and again in
-- the index, for a key nothing ever queries by: a single step is never read
-- without the rest of its history, because undo walks the array.
--
-- WITHOUT ROWID on both, because a TEXT primary key is not the rowid - SQLite
-- aliases only INTEGER PRIMARY KEY - so an ordinary table would make every read
-- an index descent plus a rowid-tree descent.
CREATE TABLE IF NOT EXISTS photo_edit_history (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  deltas   TEXT NOT NULL       -- [{ from: Partial<EditDoc>, to: Partial<EditDoc> }, ...]
) WITHOUT ROWID;
`;

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  if (!columnNames(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function columnNotNull(db: Database, table: string, column: string): boolean {
  const info = db.query(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
  return info.some((col) => col.name === column && col.notnull === 1);
}

// Names used to be optional placeholders for the root folder. They are stored
// for real now: fill any blank row from its path, then refuse NULL going forward.
function requireLibraryNames(db: Database): void {
  if (!columnNames(db, 'libraries').has('name')) return;
  const rows = db.query(`SELECT id, root_path, name FROM libraries WHERE name IS NULL OR name = ''`).all() as {
    id: string;
    root_path: string;
    name: string | null;
  }[];
  const update = db.query('UPDATE libraries SET name = ? WHERE id = ?');
  for (const row of rows) update.run(inferredLibraryName(row.root_path), row.id);
  if (!columnNotNull(db, 'libraries', 'name')) {
    db.exec('ALTER TABLE libraries ALTER COLUMN name SET NOT NULL');
  }
}

// `selected` was a two-state pick flag; triage adds "rejected" as a first-class
// verdict. Every previously picked photo keeps its pick, and the old column goes
// so there is one source of truth rather than two that can disagree.
function migrateSelectedToTriage(db: Database): void {
  const cols = columnNames(db, 'photos');
  if (!cols.has('selected')) return;
  if (!cols.has('triage')) db.exec("ALTER TABLE photos ADD COLUMN triage TEXT");
  db.exec("UPDATE photos SET triage = 'picked' WHERE selected = 1 AND triage IS NULL");
  db.exec('ALTER TABLE photos DROP COLUMN selected');
}

// `thumbnails/`, `previews/` and `lossless/` became one `renditions/` tree, so
// the columns describing them follow (§10.2). `thumbnail_hdr` goes without a
// replacement: it recorded what the full-size copy was, which is now answered by
// asking whether the HDR file exists.
//
// The per-photo viewer memory holds one of the same names, so 'render' is
// rewritten to 'full' or the viewer reopens a photo at a rendition that no
// longer exists.
function migrateThumbnailsToRenditions(db: Database): void {
  const cols = columnNames(db, 'photos');
  if (cols.has('thumbnail_source')) {
    db.exec('UPDATE photos SET rendition_source = thumbnail_source WHERE rendition_source IS NULL');
    db.exec('ALTER TABLE photos DROP COLUMN thumbnail_source');
  }
  if (cols.has('thumbnail_hdr')) db.exec('ALTER TABLE photos DROP COLUMN thumbnail_hdr');
  db.exec("UPDATE photos SET viewer_rendition = 'full' WHERE viewer_rendition = 'render'");
  db.exec("UPDATE settings SET value = 'full' WHERE value = 'render' AND key IN ('viewer_rendition_mode', 'last_viewer_rendition')");
}

// "Preview" was a second word for a rendition, and the columns and settings keys
// spelled with it disagreed with everything else the schema calls these files
// (§10.2). Renamed rather than dual-read, so there is one name per fact.
//
// Runs before every ensureColumn below: adding the new column first would leave
// the rename with a name already taken, and the old column's values stranded.
function renamePreviewColumnsToRenditions(db: Database): void {
  const rename = (table: string, from: string, to: string): void => {
    const cols = columnNames(db, table);
    if (cols.has(from) && !cols.has(to)) db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  };
  rename('photos', 'preview_rendition', 'viewer_rendition');
  rename('libraries', 'preview_source', 'rendition_source');
  rename('libraries', 'preview_hdr', 'rendition_hdr');
  db.exec("UPDATE settings SET key = 'viewer_rendition_mode' WHERE key = 'preview_rendition_mode'");
  db.exec("UPDATE settings SET key = 'last_viewer_rendition' WHERE key = 'last_preview_rendition'");
}

// One strength drove both guided filters, and the two want different amounts:
// luma grain reads as a photograph and is worth keeping some of, colour mottle has
// no such defence (§10.9). Both inherit whatever the single setting held, so an
// upgraded library renders exactly what it rendered before.
//
// Idempotent by the delete: the second run finds no `raw_denoise` to copy, and
// `OR IGNORE` keeps a value the user has since changed from being overwritten.
function splitRawDenoiseIntoLumaAndChroma(db: Database): void {
  for (const key of ['raw_denoise_luma', 'raw_denoise_chroma']) {
    db.exec(`INSERT OR IGNORE INTO settings (key, value) SELECT '${key}', value FROM settings WHERE key = 'raw_denoise'`);
  }
  db.exec("DELETE FROM settings WHERE key = 'raw_denoise'");
}

// One pending flag and one timestamp became two of each, because the import runs
// in two passes and nothing could tell them apart: the queue redid a tile it had
// already written when a run was interrupted, and a client re-fetched every grid
// tile on the page whenever a photo's *renditions* were rebuilt, the two sharing
// one stamp. Existing rows are carried over as they stand - a photo that needed
// processing needs both passes, and one that did not has both already, at the
// time the single stamp recorded.
function migrateProcessingStages(db: Database): void {
  if (!columnNames(db, 'photos').has('needs_processing')) return;
  db.exec('UPDATE photos SET needs_tile = needs_processing, needs_renditions = needs_processing');
  db.exec('UPDATE photos SET tile_built_at = date_reprocessed, renditions_built_at = date_reprocessed');
  // Before the column it is built on can go.
  db.exec('DROP INDEX IF EXISTS idx_photos_needs_processing');
  db.exec('ALTER TABLE photos DROP COLUMN needs_processing');
  db.exec('ALTER TABLE photos DROP COLUMN date_reprocessed');
}

// The second AV1 encode per HDR photo that Firefox used to need, which the
// client now does for itself out of the still it is already sent (§10.7). There
// is nothing left for the setting to turn on, and the files it produced are
// cleared by the prune sweep.
//
// Named here rather than left as a column nothing reads: a setting still in the
// row is a setting somebody will wire back up.
// Under both names it has had: the rename above no longer covers it, there being
// nothing left to rename it to.
function dropRenditionHdrVideo(db: Database): void {
  const cols = columnNames(db, 'libraries');
  for (const name of ['rendition_hdr_video', 'preview_hdr_video']) {
    if (cols.has(name)) db.exec(`ALTER TABLE libraries DROP COLUMN ${name}`);
  }
}

// The `(collection, date)` pairs the `_order_` indexes above replace. They are a
// prefix of the new keys, so every query they served is served better now, and
// keeping them would cost a second b-tree per write for nothing.
function dropSupersededOrderingIndexes(db: Database): void {
  for (const name of ['idx_photos_library_added', 'idx_photos_library_taken', 'idx_photos_shoot_added', 'idx_photos_shoot_taken']) {
    db.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}

// Shoots were once unique by name, which mirroring (§9.4.1) makes false to disk:
// a tree with NYC/Day1 and LA/Day1 is ordinary. No ALTER can swap a UNIQUE, and
// leaving the old one in place is not an option - the first sync of a library
// holding two like-named folders would throw out of the mirroring transaction on
// every run, so sync would never complete and no renditions would ever be built.
// So the table is rebuilt, which SQLite only supports the long way round.
function migrateShootsToFolderUniqueness(db: Database): void {
  const table = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shoots'").get() as
    | { sql: string }
    | null;
  if (table == null || !/UNIQUE\s*\(\s*library_id\s*,\s*name\s*\)/i.test(table.sql)) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE shoots_rebuilt (
      id            TEXT PRIMARY KEY,
      parent_id     TEXT REFERENCES shoots(id) ON DELETE CASCADE,
      library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      folder_path   TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT,
      ordering      TEXT NOT NULL DEFAULT 'taken_asc'
        CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
      folder_dev        INTEGER,
      folder_ino        INTEGER,
      folder_birthtime  REAL,
      UNIQUE (library_id, folder_path)
    )`);
    // Two shoots already sharing a folder cannot both survive a constraint that
    // says they may not; the older row keeps the folder, since the newer one is
    // the one that should never have been allowed.
    db.exec(`INSERT INTO shoots_rebuilt (id, parent_id, library_id, folder_path, name, description, ordering)
             SELECT id, parent_id, library_id, folder_path, name, description, ordering FROM shoots
             WHERE rowid IN (SELECT MIN(rowid) FROM shoots GROUP BY library_id, folder_path)`);
    // Anything pointing at a row that just lost its folder is moved to the row
    // that kept it. Foreign keys are off for the rebuild, so nothing would
    // otherwise notice, and the photos would belong to a shoot that is gone:
    // invisible in the catalogue, and binned to the library root rather than to
    // their own folder's Bin.
    const survivor = `(SELECT r.id FROM shoots_rebuilt r
                        JOIN shoots old ON old.library_id = r.library_id AND old.folder_path = r.folder_path
                       WHERE old.id = photos.shoot_id)`;
    db.exec(`UPDATE photos SET shoot_id = COALESCE(${survivor}, shoot_id)
              WHERE shoot_id IS NOT NULL AND shoot_id NOT IN (SELECT id FROM shoots_rebuilt)`);
    db.exec(`DELETE FROM shoot_banners WHERE shoot_id NOT IN (SELECT id FROM shoots_rebuilt)`);
    db.exec('DROP TABLE shoots');
    db.exec('ALTER TABLE shoots_rebuilt RENAME TO shoots');
    // The rebuilt table is a new table, so the indexes SCHEMA created above went
    // with the old one. Recreated here rather than left to the next startup: the
    // run that upgrades is exactly the run whose first mirroring sync inserts a
    // shoot per folder, and idx_shoots_parent is what serves the cascade probe on
    // every one of those writes.
    db.exec('CREATE INDEX IF NOT EXISTS idx_shoots_library ON shoots(library_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_shoots_parent ON shoots(parent_id)');
  })();
  db.exec('PRAGMA foreign_keys = ON');
}

// Every quantizer setting meant half itself, because libavif quantises on the
// midpoint of the `min`/`max` pair it was handed and `min` was 0 (§10.7). The
// encoder gets both ends now, so a value tuned against the old behaviour is halved
// to land on the same picture.
//
// The still keeps the file it had, byte for byte. **The video deliberately does not**
// - libaom read its `-crf` literally where libavif halved it, so `hdr_crf` 20 was
// encoding the AV1 twin at twice the still's quantizer, and halving the setting is
// what makes the pair match (§10.7). An existing library's twins get larger and
// better on their next build, which is the point of the change rather than a cost of
// it.
//
// The one migration here that cannot tell from the schema whether it has already
// run: a value the user chose looks exactly like one this has already halved, and
// halving twice would quietly double every rendition's size. So it is stamped, in
// the counter SQLite keeps for the purpose - `user_version` starts at 0 on every
// database that predates this and leaves no row for anything else to trip over.
const QUANTIZER_RESCALE = 1;

// The highest `user_version` this build stamps. A backup carrying more than this
// was taken by a newer Bowerbird, and restoring it would hand this one a
// catalogue whose migrations it has never heard of (§4.9).
export const LATEST_USER_VERSION = QUANTIZER_RESCALE;

function halveQuantizersLibavifWasAlreadyHalving(db: Database): void {
  const { user_version: stamped } = db.query('PRAGMA user_version').get() as { user_version: number };
  if (stamped >= QUANTIZER_RESCALE) return;
  const keys = ['grid_rendition_quantizer', 'full_rendition_quantizer', 'lossless_sdr_quantizer', 'lossless_quantizer', 'hdr_crf'];
  // Only rows the settings reader would itself have accepted. Two ways to get this
  // wrong, and SQLite offers both: `CAST('' AS INTEGER)` and `CAST('lots' AS INTEGER)`
  // are 0, so halving without a guard turns a row nothing can parse into a *valid* 0 -
  // near-lossless, in range, and preferred over the default from then on. And `CAST` is
  // a **prefix** parse, so `'26abc'` is 26; halving it leaves `'13'`, promoting a value
  // the reader was correctly discarding into one it will now use. `GLOB` requires the
  // whole string to be digits, and the range is the schema's own.
  //
  // An unparseable row is exactly what a downgrade and re-upgrade leaves behind, and
  // `settings.integration.test.ts` pins that it must not take the viewer down with it.
  db.exec(
    `UPDATE settings SET value = CAST(CAST(value AS INTEGER) / 2 AS TEXT)
      WHERE key IN (${keys.map((k) => `'${k}'`).join(', ')})
        AND value GLOB '[0-9]*' AND value NOT GLOB '*[^0-9]*'
        AND CAST(value AS INTEGER) BETWEEN 1 AND 63`,
  );
  db.exec(`PRAGMA user_version = ${QUANTIZER_RESCALE}`);
}

export function runMigrations(db: Database): void {
  db.exec(SCHEMA);
  dropSupersededOrderingIndexes(db);
  halveQuantizersLibavifWasAlreadyHalving(db);
  // Before the indexes and columns below, which are added to whichever table
  // ends up standing.
  migrateShootsToFolderUniqueness(db);
  renamePreviewColumnsToRenditions(db);
  splitRawDenoiseIntoLumaAndChroma(db);
  // Additive columns, for DBs created before each feature landed. CREATE TABLE
  // above already has them, so these are no-ops on a fresh database.
  ensureColumn(db, 'photos', 'file_size', 'INTEGER'); // stat quick-check (§9.1)
  ensureColumn(db, 'photos', 'iso', 'INTEGER'); // shooting metadata (§11.1)
  ensureColumn(db, 'photos', 'shutter_speed', 'REAL');
  ensureColumn(db, 'photos', 'aperture', 'REAL');
  ensureColumn(db, 'photos', 'focal_length', 'REAL');
  ensureColumn(db, 'photos', 'camera_make', 'TEXT');
  ensureColumn(db, 'photos', 'camera_model', 'TEXT');
  ensureColumn(db, 'photos', 'lens_model', 'TEXT');
  // The camera's UTC offset for date_taken ("+11:00"), where the body wrote one
  // (§11.1). NULL for every row imported before this landed, and for every body
  // older than EXIF 2.31; a re-read of the header fills it in.
  ensureColumn(db, 'photos', 'date_taken_offset', 'TEXT');
  ensureColumn(db, 'photos', 'rendition_source', 'TEXT'); // §10.2
  ensureColumn(db, 'photos', 'viewer_rendition', 'TEXT'); // per-photo viewer memory (§10.2)
  migrateThumbnailsToRenditions(db);
  ensureColumn(db, 'photos', 'deleted_from_path', 'TEXT'); // Bin restore (§12.2)
  // Which bin took this photo, so an undo can name that one operation instead of
  // shipping back every id it touched (§12.3). Stamped by the client, so the
  // undo works even if the answer to the delete never arrived.
  ensureColumn(db, 'photos', 'deleted_batch', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_deleted_batch ON photos(deleted_batch) WHERE deleted_batch IS NOT NULL');
  ensureColumn(db, 'libraries', 'last_synced_at', 'TEXT'); // §9.6
  // Per-library rendition settings, replacing the global import.thumbnail_source
  // (§10.2). The default matches what that setting shipped with.
  ensureColumn(db, 'libraries', 'rendition_source', "TEXT NOT NULL DEFAULT 'embedded'");
  ensureColumn(db, 'libraries', 'rendition_hdr', 'INTEGER NOT NULL DEFAULT 0');
  dropRenditionHdrVideo(db);
  // Nullable on add so existing rows can be filled before NOT NULL is applied.
  ensureColumn(db, 'libraries', 'name', 'TEXT');
  requireLibraryNames(db);
  // What the library contains, and whether its folders are shoots (§4.1).
  ensureColumn(db, 'libraries', 'include_subfolders', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'libraries', 'mirror_shoots', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'shoots', 'folder_dev', 'INTEGER'); // folder identity across a rename (§9.4.1)
  ensureColumn(db, 'shoots', 'folder_ino', 'INTEGER');
  ensureColumn(db, 'shoots', 'folder_birthtime', 'REAL');
  migrateSelectedToTriage(db);
  ensureColumn(db, 'photos', 'needs_tile', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'photos', 'needs_renditions', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'photos', 'tile_built_at', 'TEXT');
  ensureColumn(db, 'photos', 'renditions_built_at', 'TEXT');
  migrateProcessingStages(db);
  // After the columns exist rather than in SCHEMA above: that runs first, and on a
  // database being upgraded the columns are added here, so indexing them up there
  // fails on every start until the table is recreated.
  // Covers `listIdentities`, which every sync runs twice. `id` is in the key
  // because it is a TEXT primary key rather than the rowid, so without it the
  // index is not covering and the planner falls back to a table scan - which is
  // the whole point of the index. Indexing folder_ino alone would have been dead
  // weight, since nothing queries by it: the inode map is built in memory from
  // this very read.
  db.exec('DROP INDEX IF EXISTS idx_shoots_ino');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_shoots_identity
       ON shoots(library_id, folder_path, id, folder_dev, folder_ino, folder_birthtime)`,
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_needs_tile ON photos(needs_tile) WHERE needs_tile = 1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_needs_renditions ON photos(needs_renditions) WHERE needs_renditions = 1');

  // Photo stacks (§19). `stack_state` is the three answers to "is this photo in
  // a stack?": 'none' has never been in one and detection may claim it,
  // 'stacked' is in one, and 'unstacked' was pulled out by a human and is never
  // claimed again. It agrees with `stack_id` - 'stacked' exactly when the id is
  // set - and the repository writes both together rather than a CHECK spanning
  // them, because a library delete cascades `stacks` and `photos` in an order
  // SQLite does not define and such a CHECK would fire mid-cascade.
  ensureColumn(db, 'photos', 'stack_id', 'TEXT REFERENCES stacks(id) ON DELETE SET NULL');
  ensureColumn(db, 'photos', 'stack_state', "TEXT NOT NULL DEFAULT 'none' CHECK (stack_state IN ('none', 'stacked', 'unstacked'))");
  // The perceptual descriptor, written when the grid tile is built. NULL for
  // every photo imported before stacks existed, and those are never candidates:
  // there is no backfill, because rebuilding tiles is already the way to ask for
  // one (§19.4.2).
  ensureColumn(db, 'photos', 'descriptor', 'BLOB');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_stack ON photos(stack_id)');
  // Detection's candidate scan: the loose and already-stacked photos of one
  // library, in time order. Leading with the state keeps it off the photos that
  // are none of its business, which on a mature library is most of them.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_photos_stack_candidates
       ON photos(library_id, stack_state, date_taken, date_added, id)`,
  );
  // Which member of a stack stands for it in a listing (§19.5.1). 1 on every
  // photograph that is in no stack, and on one member of each stack.
  //
  // A hint rather than a truth: the listing falls back to promoting the newest
  // visible member when this one is hidden, so a stale flag costs a little speed
  // and never correctness. What it must never be is set on two members of one
  // stack, which would show that stack twice - hence the unique index, which
  // turns a bookkeeping slip into an error at the write rather than a duplicate
  // tile nobody notices.
  ensureColumn(db, 'photos', 'is_representative', 'INTEGER NOT NULL DEFAULT 1');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_one_representative
       ON photos(stack_id) WHERE stack_id IS NOT NULL AND is_representative = 1`,
  );
  // Catches up any stack that predates the column, and is a no-op afterwards.
  db.exec(
    `UPDATE photos SET is_representative = 0
       WHERE stack_id IS NOT NULL AND is_representative = 1
         AND id <> (SELECT m.id FROM photos m WHERE m.stack_id = photos.stack_id
                    ORDER BY COALESCE(m.date_taken, m.date_added) DESC, m.id DESC LIMIT 1)`,
  );
  ensureColumn(db, 'libraries', 'auto_stack', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'libraries', 'auto_stack_similarity', 'REAL NOT NULL DEFAULT 0.78');
  ensureColumn(db, 'libraries', 'auto_stack_window_seconds', 'INTEGER NOT NULL DEFAULT 60');
  seedSettings(db);
}

// The shipped defaults as rows, so a fresh database holds what the app is running
// on rather than leaving every untouched key implicit and readable only from the
// schema. `OR IGNORE`, so this fills in a key a later version adds and never
// overwrites one somebody set.
//
// A null default is left absent rather than written as a string: an absent row
// already means "nothing chosen", which is what `last_viewer_rendition` is until
// a rendition has been.
function seedSettings(db: Database): void {
  const insert = db.query('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (value != null) insert.run(key, String(value));
  }
}

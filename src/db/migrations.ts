import type { Database } from 'bun:sqlite';

// Schema creation. Tables are ordered so every REFERENCES target already exists.
// Idempotent (IF NOT EXISTS) so it is safe to run on every startup. See DESIGN §4.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS libraries (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  data_path   TEXT,
  last_synced_at TEXT,          -- ISO datetime of the last completed sync; NULL if never synced
  ordering    TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  -- Where thumbnails and previews get their pixels, and whether the full-size
  -- render is HDR (§10.2). Per library rather than global: one catalogue may be
  -- scanned JPEGs where the camera's rendering is the point, another RAWs worth
  -- demosaicing. 'embedded' is the default because it needs no demosaic.
  preview_source TEXT NOT NULL DEFAULT 'embedded'
    CHECK (preview_source IN ('embedded', 'render')),
  -- Only meaningful with 'render': an embedded JPEG is 8-bit SDR, so there is no
  -- headroom in it to carry.
  preview_hdr INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shoots (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES shoots(id) ON DELETE CASCADE,
  library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  folder_path   TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  ordering      TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc')),
  UNIQUE (library_id, name)
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
  date_taken        TEXT,
  date_added        TEXT NOT NULL,
  date_updated      TEXT,
  date_reprocessed  TEXT,
  needs_processing  INTEGER NOT NULL DEFAULT 1,
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
  rating            INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  -- Cull verdict. NULL means untriaged, which is a real third state: "not yet
  -- judged" is what a photographer filters on, and a boolean cannot say it.
  triage            TEXT CHECK (triage IN ('picked', 'rejected')),
  notes             TEXT,
  -- Which pixels the thumbnails were built from (§10.3). Set to the requested
  -- source when work is queued, corrected to what was actually used on success.
  thumbnail_source  TEXT CHECK (thumbnail_source IN ('embedded', 'render'))
);
CREATE INDEX IF NOT EXISTS idx_photos_library ON photos(library_id);
CREATE INDEX IF NOT EXISTS idx_photos_shoot ON photos(shoot_id);
CREATE INDEX IF NOT EXISTS idx_photos_library_added ON photos(library_id, date_added);
CREATE INDEX IF NOT EXISTS idx_photos_library_taken ON photos(library_id, date_taken);
CREATE INDEX IF NOT EXISTS idx_photos_shoot_added ON photos(shoot_id, date_added);
CREATE INDEX IF NOT EXISTS idx_photos_shoot_taken ON photos(shoot_id, date_taken);
CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(library_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_photos_file_path ON photos(library_id, file_path);
CREATE INDEX IF NOT EXISTS idx_photos_needs_processing ON photos(needs_processing) WHERE needs_processing = 1;
CREATE INDEX IF NOT EXISTS idx_photos_is_missing ON photos(library_id, is_missing) WHERE is_missing = 1;
CREATE INDEX IF NOT EXISTS idx_photos_is_deleted ON photos(library_id, is_deleted) WHERE is_deleted = 1;

CREATE TABLE IF NOT EXISTS albums (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  ordering        TEXT NOT NULL DEFAULT 'taken_desc'
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

-- Runtime settings the user can change from the app, as opposed to the
-- deployment config in environment variables (§15).
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

function columnNames(db: Database, table: string): Set<string> {
  return new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  if (!columnNames(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

export function runMigrations(db: Database): void {
  db.exec(SCHEMA);
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
  ensureColumn(db, 'photos', 'thumbnail_source', 'TEXT'); // §10.3
  ensureColumn(db, 'photos', 'deleted_from_path', 'TEXT'); // Bin restore (§12.2)
  ensureColumn(db, 'libraries', 'last_synced_at', 'TEXT'); // §9.6
  // Per-library preview settings, replacing the global import.thumbnail_source
  // (§10.2). The default matches what that setting shipped with.
  ensureColumn(db, 'libraries', 'preview_source', "TEXT NOT NULL DEFAULT 'embedded'");
  ensureColumn(db, 'libraries', 'preview_hdr', 'INTEGER NOT NULL DEFAULT 0');
  migrateSelectedToTriage(db);
}

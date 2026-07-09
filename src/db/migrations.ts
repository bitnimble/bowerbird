import type { Database } from 'bun:sqlite';

// Schema creation. Tables are ordered so every REFERENCES target already exists.
// Idempotent (IF NOT EXISTS) so it is safe to run on every startup. See DESIGN §4.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS libraries (
  id          TEXT PRIMARY KEY,
  root_path   TEXT NOT NULL UNIQUE,
  data_path   TEXT,
  ordering    TEXT NOT NULL DEFAULT 'taken_desc'
    CHECK (ordering IN ('taken_asc', 'taken_desc', 'added_asc', 'added_desc'))
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
  rating            INTEGER NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  selected          INTEGER NOT NULL DEFAULT 0,
  notes             TEXT
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
`;

export function runMigrations(db: Database): void {
  db.exec(SCHEMA);
}

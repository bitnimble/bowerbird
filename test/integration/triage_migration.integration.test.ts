// `selected` (a two-state pick flag) became `triage` (picked / rejected /
// untriaged). An existing catalogue must keep every pick it had.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';

// The photos table as it stood before triage existed.
const LEGACY = `
CREATE TABLE libraries (
  id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, data_path TEXT,
  ordering TEXT NOT NULL DEFAULT 'taken_desc'
);
CREATE TABLE shoots (
  id TEXT PRIMARY KEY, parent_id TEXT, library_id TEXT NOT NULL,
  folder_path TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  ordering TEXT NOT NULL DEFAULT 'taken_desc', UNIQUE (library_id, name)
);
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  shoot_id TEXT REFERENCES shoots(id) ON DELETE SET NULL,
  file_hash TEXT, file_path TEXT NOT NULL, file_size INTEGER,
  width INTEGER NOT NULL, height INTEGER NOT NULL, orientation INTEGER NOT NULL DEFAULT 0,
  is_missing INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
  date_taken TEXT, date_added TEXT NOT NULL, date_updated TEXT, date_reprocessed TEXT,
  needs_processing INTEGER NOT NULL DEFAULT 1, processing_error TEXT,
  latitude REAL, longitude REAL,
  rating INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
`;

function legacyDb(): Database {
  const db = new Database(':memory:');
  db.exec(LEGACY);
  db.query("INSERT INTO libraries (id, root_path) VALUES ('lib', '/tmp/legacy')").run();
  const insert = db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, selected)
     VALUES (?, 'lib', ?, 10, 10, '2026-01-01T00:00:00.000Z', ?)`,
  );
  insert.run('picked-1', 'a.arw', 1);
  insert.run('picked-2', 'b.arw', 1);
  insert.run('plain-1', 'c.arw', 0);
  return db;
}

function columns(db: Database): Set<string> {
  return new Set((db.query('PRAGMA table_info(photos)').all() as { name: string }[]).map((c) => c.name));
}

test('every previously selected photo becomes picked, and the rest untriaged', () => {
  const db = legacyDb();
  runMigrations(db);

  const rows = db.query('SELECT id, triage FROM photos ORDER BY id').all() as { id: string; triage: string | null }[];
  expect(rows).toEqual([
    { id: 'picked-1', triage: 'picked' },
    { id: 'picked-2', triage: 'picked' },
    { id: 'plain-1', triage: null },
  ]);
  db.close();
});

test('the old column is dropped so the two can never disagree', () => {
  const db = legacyDb();
  runMigrations(db);

  const cols = columns(db);
  expect(cols.has('triage')).toBe(true);
  expect(cols.has('selected')).toBe(false);
  db.close();
});

test('running migrations twice is a no-op', () => {
  const db = legacyDb();
  runMigrations(db);
  runMigrations(db);

  expect(db.query("SELECT COUNT(*) n FROM photos WHERE triage = 'picked'").get()).toEqual({ n: 2 });
  db.close();
});

test('a fresh database starts with triage and never had selected', () => {
  const db = new Database(':memory:');
  runMigrations(db);

  const cols = columns(db);
  expect(cols.has('triage')).toBe(true);
  expect(cols.has('selected')).toBe(false);
  db.close();
});

test('the triage column rejects a value outside the three states', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  db.query("INSERT INTO libraries (id, root_path, name, ordering) VALUES ('lib', '/tmp/x', 'lib', 'taken_desc')").run();

  expect(() =>
    db
      .query(
        `INSERT INTO photos (id, library_id, file_path, width, height, date_added, triage)
         VALUES ('bad', 'lib', 'a.arw', 10, 10, '2026-01-01T00:00:00.000Z', 'maybe')`,
      )
      .run(),
  ).toThrow();
  db.close();
});

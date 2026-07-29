// Upgrading a database whose shoots are still unique by name. Left in place, the
// first mirroring sync of a library holding two like-named folders throws out of
// its transaction on every run, so sync never completes and no rendition is ever
// built. Needs bun:sqlite:
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/db/migrations';

const LIB = '00000000-0000-4000-8000-0000000000b1';

// The shape `main` created, before a shoot was identified by its folder.
function oldDatabase(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE libraries (
      id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, data_path TEXT, name TEXT,
      last_synced_at TEXT, ordering TEXT NOT NULL DEFAULT 'taken_asc'
    );
    CREATE TABLE shoots (
      id            TEXT PRIMARY KEY,
      parent_id     TEXT REFERENCES shoots(id) ON DELETE CASCADE,
      library_id    TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
      folder_path   TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT,
      ordering      TEXT NOT NULL DEFAULT 'taken_asc',
      UNIQUE (library_id, name)
    );
  `);
  db.query('INSERT INTO libraries (id, root_path) VALUES (?, ?)').run(LIB, '/tmp/bb-migrate');
  return db;
}

function shootsDdl(db: Database): string {
  return (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shoots'").get() as { sql: string }).sql;
}

test('rebuilds shoots so two folders may share a name', () => {
  const db = oldDatabase();
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run('a', LIB, 'NYC/Day1', 'Day1');

  runMigrations(db);

  expect(shootsDdl(db)).toContain('UNIQUE (library_id, folder_path)');
  expect(shootsDdl(db)).not.toMatch(/UNIQUE\s*\(\s*library_id\s*,\s*name\s*\)/);

  // The insert the old constraint refused, which mirroring makes ordinary.
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run('b', LIB, 'LA/Day1', 'Day1');
  expect((db.query('SELECT COUNT(*) AS n FROM shoots').get() as { n: number }).n).toBe(2);
  db.close();
});

test('keeps the shoots it carries over, and refuses two in one folder afterwards', () => {
  const db = oldDatabase();
  db.query('INSERT INTO shoots (id, library_id, folder_path, name, description) VALUES (?, ?, ?, ?, ?)').run(
    'keep',
    LIB,
    'Trip',
    'Iceland, March',
    'the good one',
  );

  runMigrations(db);

  const row = db.query('SELECT name, description, folder_path FROM shoots WHERE id = ?').get('keep') as {
    name: string;
    description: string;
    folder_path: string;
  };
  expect(row).toEqual({ name: 'Iceland, March', description: 'the good one', folder_path: 'Trip' });

  expect(() =>
    db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run('dupe', LIB, 'Trip', 'Other'),
  ).toThrow();
  db.close();
});

// A database that already had the old constraint could hold two shoots in one
// folder, which the new one cannot express.
test('keeps the older of two shoots that shared a folder', () => {
  const db = oldDatabase();
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run('first', LIB, 'Trip', 'Trip');
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run('second', LIB, 'Trip', 'Trip2');

  runMigrations(db);

  const ids = (db.query('SELECT id FROM shoots').all() as { id: string }[]).map((r) => r.id);
  expect(ids).toEqual(['first']);
  db.close();
});

test('leaves an already-migrated database alone', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const before = shootsDdl(db);

  runMigrations(db); // idempotent, as every startup depends on

  expect(shootsDdl(db)).toBe(before);
  db.close();
});

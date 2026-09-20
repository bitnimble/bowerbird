import { describe, it, expect } from 'bun:test';
import { Database } from '../driver';
import { runMigrations } from '../migrate';

// The CHECK constraints, exercised rather than read. A constraint is invisible to `table_info`, so
// the only way to know one survived the schema being generated is to hand it a row it must refuse.
function catalogue(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.exec(`INSERT INTO libraries (id, root_path, name) VALUES ('lib', '/r', 'L')`);
  db.exec(`INSERT INTO shoots (id, library_id, folder_path, name) VALUES ('sh', 'lib', 'f', 'S')`);
  db.exec(`INSERT INTO stacks (id, library_id, origin, date_created) VALUES ('st', 'lib', 'auto', 'now')`);
  db.exec(
    `INSERT INTO photos (id, library_id, width, height, date_added, recipe) VALUES ('p', 'lib', 1, 1, 'now', '{}')`,
  );
  return db;
}

const REFUSED: [string, string][] = [
  ['libraries.ordering', `UPDATE libraries SET ordering = 'sideways' WHERE id = 'lib'`],
  ['libraries.rendition_source', `UPDATE libraries SET rendition_source = 'guess' WHERE id = 'lib'`],
  ['shoots.ordering', `UPDATE shoots SET ordering = 'sideways' WHERE id = 'sh'`],
  ['albums.ordering', `INSERT INTO albums (id, name, ordering) VALUES ('a', 'A', 'sideways')`],
  ['stacks.origin', `UPDATE stacks SET origin = 'somehow' WHERE id = 'st'`],
  ['photos.rating below zero', `UPDATE photos SET rating = -1 WHERE id = 'p'`],
  ['photos.rating above five', `UPDATE photos SET rating = 6 WHERE id = 'p'`],
  ['photos.triage', `UPDATE photos SET triage = 'maybe' WHERE id = 'p'`],
  ['photos.rendition_source', `UPDATE photos SET rendition_source = 'guess' WHERE id = 'p'`],
  ['photos.stack_state', `UPDATE photos SET stack_state = 'wobbly' WHERE id = 'p'`],
  // An UPDATE, not an INSERT: `photos_owe_renditions` already made the grid row, so an insert
  // would collide on the primary key and pass this test without the CHECK existing at all.
  ['renditions.source', `UPDATE renditions SET source = 'guess' WHERE photo_id = 'p' AND variant = 'grid'`],
  ['folder_rules.rule', `INSERT INTO folder_rules (library_id, folder_path, rule) VALUES ('lib', 'f', 'sometimes')`],
  [
    'blob_transfers.direction',
    `INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, queued_at)
       VALUES ('b', 'lib', 'p', 'pe', 'sideways', 'now')`,
  ],
  [
    'blob_transfers.state',
    `INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, state, queued_at)
       VALUES ('b2', 'lib', 'p', 'pe', 'push', 'dithering', 'now')`,
  ],
  ['replication_identity.singleton', `INSERT INTO replication_identity (singleton, peer_id, name) VALUES (2, 'x', 'y')`],
];

const ACCEPTED: [string, string][] = [
  ['libraries.ordering', `UPDATE libraries SET ordering = 'added_desc' WHERE id = 'lib'`],
  ['photos.rating at the ceiling', `UPDATE photos SET rating = 5 WHERE id = 'p'`],
  ['photos.triage', `UPDATE photos SET triage = 'rejected' WHERE id = 'p'`],
  ['renditions.source', `UPDATE renditions SET source = 'render' WHERE photo_id = 'p' AND variant = 'grid'`],
];

describe('the schema refuses a value outside what a column may hold', () => {
  for (const [name, sql] of REFUSED) {
    it(`refuses ${name}`, () => {
      const db = catalogue();
      try {
        expect(() => db.exec(sql)).toThrow();
      } finally {
        db.close();
      }
    });
  }

  for (const [name, sql] of ACCEPTED) {
    it(`accepts a good ${name}`, () => {
      const db = catalogue();
      try {
        expect(() => db.exec(sql)).not.toThrow();
      } finally {
        db.close();
      }
    });
  }
});

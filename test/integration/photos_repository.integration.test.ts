// Repository-level DB behaviour that can't run under host jest (needs bun:sqlite):
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { PhotosRepository } from '../../src/services/photos/photos_repository';

const LIB = '00000000-0000-4000-8000-000000000abc';

let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;

function insertPhoto(id: string, isDeleted: number): void {
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, is_deleted)
     VALUES (?, ?, ?, 100, 100, '2024-01-01T00:00:00.000Z', ?)`,
  ).run(id, LIB, `${id}.arw`, isDeleted);
}

function insertMissing(id: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, is_missing)
     VALUES (?, ?, ?, 100, 100, '2024-01-01T00:00:00.000Z', 1)`,
  ).run(id, LIB, `${id}.arw`);
}

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, '/tmp/bb-repo-test', 'taken_desc');
  photos = new PhotosRepository(db);
  insertPhoto('active', 0);
  insertPhoto('deleted', 1);
});

afterAll(() => db.close());

// Regression: shoot membership ops (addPhotos/removePhotos) are the only callers.
// A Bin-resident deleted photo must never be returned, else it gets moved out of
// its Bin while still flagged is_deleted and re-imported as a duplicate.
test('getBasicByIds excludes soft-deleted photos', () => {
  const result = photos.getBasicByIds(['active', 'deleted']);
  expect(result.map((p) => p.id)).toEqual(['active']);
});

// Regression: a scoped sync can pass thousands of discovered paths; the chunked
// IN(...) must not exceed SQLite's variable limit (would throw and drop the change).
test('listForSyncByPaths handles a path count over the variable limit', () => {
  insertPhoto('bulk', 0); // file_path = 'bulk.arw'
  const manyPaths = [...Array(5000)].map((_, i) => `ghost-${i}.arw`);
  manyPaths.push('bulk.arw');
  const result = photos.listForSyncByPaths(LIB, manyPaths);
  expect(result.map((p) => p.file_path)).toContain('bulk.arw');
});

const missingOf = (id: string) => (db.query('SELECT is_missing FROM photos WHERE id = ?').get(id) as { is_missing: number }).is_missing;

// Regression: setMissing is path-guarded so a photo relocated by a concurrent
// shoot rename/move during a sync scan isn't spuriously flagged missing.
test('setMissing marks missing only when file_path still matches the scanned path', () => {
  insertPhoto('mv', 0);
  expect(photos.setMissing('mv', 'nope.arw')).toBe(false); // path moved out from under the scan
  expect(missingOf('mv')).toBe(0);
  expect(photos.setMissing('mv', 'mv.arw')).toBe(true); // matches -> genuinely missing
  expect(missingOf('mv')).toBe(1);
});

// Regression: a move-op runs only after the file exists at the new path, so it
// must clear is_missing; else a concurrent sync's setMissing landing just before
// leaves the present photo stuck missing until the next sync.
test('setFilePath / setFilePathAndShoot clear is_missing', () => {
  insertMissing('rel');
  photos.setFilePath('rel', 'rel-moved.arw');
  expect(missingOf('rel')).toBe(0);

  insertMissing('rel2');
  photos.setFilePathAndShoot('rel2', 'rel2-moved.arw', null);
  expect(missingOf('rel2')).toBe(0);
});


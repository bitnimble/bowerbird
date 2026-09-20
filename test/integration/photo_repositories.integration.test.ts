// Repository-level DB behaviour, which needs a real catalogue rather than a double:
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import type { PhotoMetadataRepository } from '../../src/services/photos/metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../src/services/photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../src/services/photos/renditions/photo_processing_repository';
import type { PhotoScanRepository } from '../../src/services/photos/scan/photo_scan_repository';
import { photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';

const LIB = 'lib000ab';

let db: ReturnType<typeof createDatabase>;
let metadata: PhotoMetadataRepository;
let paths: PhotoPathsRepository;
let processing: PhotoProcessingRepository;
let scan: PhotoScanRepository;

function insertPhoto(id: string, isDeleted: number): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted)
     VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2024-01-01T00:00:00.000Z', ?)`,
  ).run(id, LIB, `${id}.arw`, isDeleted);
}

function insertMissing(id: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_missing)
     VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2024-01-01T00:00:00.000Z', 1)`,
  ).run(id, LIB, `${id}.arw`);
}

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, '/tmp/bb-repo-test', 'lib', 'taken_desc');
  processing = photoProcessing(db);
  paths = photoPaths(db);
  metadata = photoMetadata(db, processing);
  scan = photoScan(db, processing);
  insertPhoto('active', 0);
  insertPhoto('deleted', 1);
});

afterAll(() => db.close());

// Regression: shoot membership ops (addPhotos/removePhotos) are the only callers.
// A Bin-resident deleted photo must never be returned, else it gets moved out of
// its Bin while still flagged is_deleted and re-imported as a duplicate.
test('getBasicByIds excludes soft-deleted photos', () => {
  const result = paths.getBasicByIds(['active', 'deleted']);
  expect(result.map((p) => p.id)).toEqual(['active']);
});

// Regression: a scoped sync can pass thousands of discovered paths; the chunked
// IN(...) must not exceed SQLite's variable limit (would throw and drop the change).
test('listForScanByPaths handles a path count over the variable limit', () => {
  insertPhoto('bulk', 0); // file_path = 'bulk.arw'
  const manyPaths = [...Array(5000)].map((_, i) => `ghost-${i}.arw`);
  manyPaths.push('bulk.arw');
  const result = scan.listForScanByPaths(LIB, manyPaths);
  expect(result.map((p) => p.file_path)).toContain('bulk.arw');
});

const missingOf = (id: string) => (db.query('SELECT is_missing FROM photos WHERE id = ?').get(id) as { is_missing: number }).is_missing;

// Regression: setMissing is path-guarded so a photo relocated by a concurrent
// shoot rename/move during a sync scan isn't spuriously flagged missing.
test('setMissing marks missing only when file_path still matches the scanned path', () => {
  insertPhoto('mv', 0);
  expect(metadata.setMissing('mv', 'nope.arw')).toBe(false); // path moved out from under the scan
  expect(missingOf('mv')).toBe(0);
  expect(metadata.setMissing('mv', 'mv.arw')).toBe(true); // matches -> genuinely missing
  expect(missingOf('mv')).toBe(1);
});

// The rendition queue is built in the order the grid will show it, so the first
// screenful of a large import is the first to fill in (§10.2). Insertion order is
// deliberately the reverse of capture order here: returning these in the order
// they were written is exactly the failure, and it is invisible on a small library.
test('listPendingProcessing queues photos in the library grid order', () => {
  const ORD = 'lib000rd';
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(ORD, '/tmp/bb-ordering', 'lib', 'taken_asc');
  const taken: [string, string | null][] = [
    ['newest', '2024-03-01T00:00:00.000Z'],
    ['undated', null],
    ['oldest', '2020-01-01T00:00:00.000Z'],
    ['middle', '2022-06-01T00:00:00.000Z'],
  ];
  for (const [id, date] of taken) {
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added, date_taken)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2024-01-01T00:00:00.000Z', ?)`,
    ).run(id, ORD, `${id}.arw`, date);
  }

  const ids = (): string[] => processing.listPendingProcessing(ORD).map((p) => p.photo_id);
  // Undated last in both directions, matching the grid (DESIGN §5.1).
  expect(ids()).toEqual(['oldest', 'middle', 'newest', 'undated']);

  db.query('UPDATE libraries SET ordering = ? WHERE id = ?').run('taken_desc', ORD);
  expect(ids()).toEqual(['newest', 'middle', 'oldest', 'undated']);

  db.query('UPDATE libraries SET ordering = ? WHERE id = ?').run('added_asc', ORD);
  expect(ids()).toHaveLength(4); // date_added is identical, so only the tie-break id order is defined
});

// Regression: a move-op runs only after the file exists at the new path, so it
// must clear is_missing; else a concurrent sync's setMissing landing just before
// leaves the present photo stuck missing until the next sync.
test('setFilePath / setFilePathAndShoot clear is_missing', () => {
  insertMissing('rel');
  paths.setFilePath('rel', 'rel-moved.arw');
  expect(missingOf('rel')).toBe(0);

  insertMissing('rel2');
  paths.setFilePathAndShoot('rel2', 'rel2-moved.arw', null);
  expect(missingOf('rel2')).toBe(0);
});

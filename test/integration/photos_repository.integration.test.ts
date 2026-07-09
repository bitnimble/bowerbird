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

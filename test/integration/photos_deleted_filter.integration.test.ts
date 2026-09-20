// The Bin view needs "only soft-deleted", which include_deleted alone cannot
// express (it widens to live + deleted). DESIGN §13.2.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { PhotoListingRepository } from '../../src/services/photos/listing/photo_listing_repository';

const LIB = 'lib000df';
let db: ReturnType<typeof createDatabase>;
let photos: PhotoListingRepository;

function insert(id: string, deleted: boolean): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted)
     VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, LIB, `${id}.arw`, deleted ? 1 : 0);
}

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, '/tmp/bb-filter', 'lib', 'added_desc');
  photos = new PhotoListingRepository(db);
  insert('photo001', false);
  insert('photo002', true);
  insert('photo003', true);
});

afterAll(() => db.close());

const list = (filters: Parameters<PhotoListingRepository['listByLibrary']>[4]) =>
  photos.listByLibrary(LIB, 'added_desc', 0, 100, filters);

test('the default view hides soft-deleted photos', () => {
  const res = list({ includeDeleted: false });
  expect(res.total).toBe(1);
  expect(res.photos.every((p) => !p.is_deleted)).toBe(true);
});

test('include_deleted alone widens to live and deleted together', () => {
  expect(list({ includeDeleted: true }).total).toBe(3);
});

test('include_deleted with is_deleted selects only the Bin', () => {
  const res = list({ includeDeleted: true, isDeleted: true });
  expect(res.total).toBe(2);
  expect(res.photos.every((p) => p.is_deleted)).toBe(true);
});

test('is_deleted=false selects only live photos', () => {
  const res = list({ includeDeleted: true, isDeleted: false });
  expect(res.total).toBe(1);
  expect(res.photos[0]?.is_deleted).toBe(false);
});

// The Bin view needs "only soft-deleted", which include_deleted alone cannot
// express (it widens to live + deleted). DESIGN §13.2.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { PhotosRepository } from '../../src/services/photos/photos_repository';

const LIB = '00000000-0000-4000-8000-0000000000df';
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;

function insert(id: string, deleted: boolean): void {
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, is_deleted, needs_tile, needs_renditions)
     VALUES (?, ?, ?, 100, 100, '2026-01-01T00:00:00.000Z', ?, 0, 0)`,
  ).run(id, LIB, `${id}.arw`, deleted ? 1 : 0);
}

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, '/tmp/bb-filter', 'added_desc');
  photos = new PhotosRepository(db);
  insert('11111111-1111-4111-8111-111111111111', false);
  insert('22222222-2222-4222-8222-222222222222', true);
  insert('33333333-3333-4333-8333-333333333333', true);
});

afterAll(() => db.close());

const list = (filters: Parameters<PhotosRepository['listByLibrary']>[4]) =>
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

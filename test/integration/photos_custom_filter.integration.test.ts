// The Custom filter menu unions its chips (match: 'any') and the calendar
// narrows by the date the grid shows. Both are new WHERE-building paths.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { PhotosRepository } from '../../src/services/photos/photos_repository';

const LIB = '00000000-0000-4000-8000-0000000000c5';
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;

interface Row {
  id: string;
  taken: string | null;
  rating?: number;
  triage?: string | null;
  missing?: boolean;
}

function insert({ id, taken, rating = 0, triage = null, missing = false }: Row): void {
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_taken, date_added, rating, triage, is_missing, is_deleted, needs_processing)
     VALUES (?, ?, ?, 100, 100, ?, '2020-01-01T00:00:00.000Z', ?, ?, ?, 0, 0)`,
  ).run(id, LIB, `${id}.arw`, taken, rating, triage, missing ? 1 : 0);
}

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, '/tmp/bb-custom', 'taken_desc');
  photos = new PhotosRepository(db);
  insert({ id: id(1), taken: '2024-05-01T09:00:00.000Z', rating: 4, triage: 'picked' });
  insert({ id: id(2), taken: '2024-05-03T23:30:00.000Z', rating: 0 });
  insert({ id: id(3), taken: '2024-06-10T09:00:00.000Z', rating: 3, missing: true });
  // No date_taken: falls back to date_added (2020), which is what the grid shows.
  insert({ id: id(4), taken: null, rating: 5, triage: 'rejected' });
});

afterAll(() => db.close());

const list = (filters: Parameters<PhotosRepository['listByLibrary']>[4]) =>
  photos.listByLibrary(LIB, 'taken_desc', 0, 100, filters);

test('match all intersects the chips, which is usually empty', () => {
  expect(list({ includeDeleted: false, rated: false, isMissing: true }).total).toBe(0);
});

test('match any unions the chips', () => {
  // unrated (#2) plus missing (#3).
  const res = list({ includeDeleted: false, rated: false, isMissing: true, match: 'any' });
  expect(res.total).toBe(2);
  expect(res.photos.map((p) => p.id).sort()).toEqual([id(2), id(3)].sort());
});

test('match any still intersects with scope filters like search', () => {
  const res = list({ includeDeleted: false, rated: false, isMissing: true, match: 'any', search: `${id(3)}.arw` });
  expect(res.total).toBe(1);
  expect(res.photos[0]?.id).toBe(id(3));
});

test('the date range is inclusive of the closing day', () => {
  // #2 is taken at 23:30 on the closing day, so an exclusive bound would drop it.
  const res = list({ includeDeleted: false, takenFrom: '2024-05-01', takenTo: '2024-05-03' });
  expect(res.total).toBe(2);
  expect(res.photos.map((p) => p.id).sort()).toEqual([id(1), id(2)].sort());
});

test('a photo the camera never dated is filtered by the date it fell back to', () => {
  expect(list({ includeDeleted: false, takenFrom: '2020-01-01', takenTo: '2020-01-01' }).photos.map((p) => p.id)).toEqual([id(4)]);
  expect(list({ includeDeleted: false, takenFrom: '2024-01-01' }).photos.map((p) => p.id)).not.toContain(id(4));
});

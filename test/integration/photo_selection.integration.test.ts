// A selection is runs of positions in a filtered listing (§18.3.3), and the
// server reads the ids off the same query the grid was built from. What matters
// is that the two agree exactly: the same filters, the same collection-owned
// ordering, the same offsets.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { PhotosRepository } from '../../src/services/photos/photos_repository';

const LIB = '00000000-0000-4000-8000-0000000000d1';
const COUNT = 250;
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, '/tmp/bb-selection', 'taken_asc');
  photos = new PhotosRepository(db);
  const insert = db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_taken, date_added, rating, triage, is_missing, is_deleted, needs_tile, needs_renditions)
     VALUES (?, ?, ?, 100, 100, ?, '2020-01-01T00:00:00.000Z', 0, ?, 0, 0, 0, 0)`,
  );
  db.transaction(() => {
    for (let n = 0; n < COUNT; n++) {
      const taken = new Date(Date.UTC(2024, 0, 1, 0, n)).toISOString();
      insert.run(id(n), LIB, `frame_${String(n).padStart(4, '0')}.arw`, taken, n % 3 === 0 ? 'picked' : null);
    }
  })();
});

afterAll(() => db.close());

const listed = (filters: Parameters<PhotosRepository['listByLibrary']>[4], offset = 0, limit = COUNT) =>
  photos.listByLibrary(LIB, 'taken_asc', offset, limit, filters).photos.map((p) => p.id);

const unfiltered = { includeDeleted: false };

test('a run resolves to exactly the ids the grid shows at those positions', () => {
  expect(photos.idsInLibrary(LIB, 'taken_asc', [{ start: 10, end: 19 }], unfiltered)).toEqual(listed(unfiltered, 10, 10));
});

test('the whole collection is one run, not two hundred and fifty entries', () => {
  const all = photos.idsInLibrary(LIB, 'taken_asc', [{ start: 0, end: COUNT - 1 }], unfiltered);
  expect(all).toHaveLength(COUNT);
  expect(all).toEqual(listed(unfiltered));
});

test('several runs resolve in order, and a hole stays a hole', () => {
  const picked = photos.idsInLibrary(
    LIB,
    'taken_asc',
    [
      { start: 0, end: 1 },
      { start: 5, end: 5 },
    ],
    unfiltered,
  );
  expect(picked).toEqual([id(0), id(1), id(5)]);
});

// The positions were produced against a filtered listing, so resolving them
// against an unfiltered one would act on photographs the reader never saw.
test('positions are into the filtered listing, not the whole collection', () => {
  const filters = { includeDeleted: false, triage: ['picked' as const] };
  const resolved = photos.idsInLibrary(LIB, 'taken_asc', [{ start: 0, end: 4 }], filters);
  expect(resolved).toEqual([id(0), id(3), id(6), id(9), id(12)]);
  expect(resolved).toEqual(listed(filters, 0, 5));
});

test('a run reaching past the end stops at the end rather than erroring', () => {
  const resolved = photos.idsInLibrary(LIB, 'taken_asc', [{ start: COUNT - 2, end: COUNT + 1000 }], unfiltered);
  expect(resolved).toEqual([id(COUNT - 2), id(COUNT - 1)]);
});

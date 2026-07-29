// Repository-level DB behaviour that can't run under host jest (needs bun:sqlite):
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createDatabase } from '../../src/db/connection';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import type { Ordering } from '../../src/schemas/common';

const LIB = '00000000-0000-4000-8000-000000000abc';

let db: ReturnType<typeof createDatabase>;
let shoots: ShootsRepository;

function insertShoot(id: string, ordering: Ordering): void {
  shoots.insert({
    id,
    parent_id: null,
    library_id: LIB,
    folder_path: id,
    name: id,
    description: null,
    ordering,
    folder_dev: null,
    folder_ino: null,
    folder_birthtime: null,
  });
}

// date_taken is deliberately out of step with date_added, so an ordering read off
// the wrong column is visible rather than coincidentally right.
function insertPhoto(id: string, shootId: string, taken: string | null, added: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, file_path, width, height, date_taken, date_added)
     VALUES (?, ?, ?, ?, 100, 100, ?, ?)`,
  ).run(id, LIB, shootId, `${shootId}/${id}.arw`, taken, added);
}

beforeAll(() => {
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, '/tmp/bb-shoot-repo-test', 'taken_asc');
  shoots = new ShootsRepository(db);
});

afterAll(() => db.close());

test('a shoot with no banner shows its first photo, in the shoot ordering', () => {
  insertShoot('Asc', 'taken_asc');
  insertPhoto('a-late', 'Asc', '2024-06-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  insertPhoto('a-early', 'Asc', '2024-01-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');
  expect(shoots.getById('Asc')?.banner_photo_id).toBe('a-early');

  insertShoot('Desc', 'taken_desc');
  insertPhoto('d-late', 'Desc', '2024-06-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  insertPhoto('d-early', 'Desc', '2024-01-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');
  expect(shoots.getById('Desc')?.banner_photo_id).toBe('d-late');

  insertShoot('Added', 'added_desc');
  insertPhoto('add-first', 'Added', '2024-06-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  insertPhoto('add-last', 'Added', '2024-01-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');
  expect(shoots.getById('Added')?.banner_photo_id).toBe('add-last');
});

// A photo the camera left undated sorts last whichever way the shoot reads, so it
// is only the banner when it is the only photo there is.
test('an undated photo does not become the banner ahead of a dated one', () => {
  insertShoot('Undated', 'taken_asc');
  insertPhoto('u-none', 'Undated', null, '2023-01-01T00:00:00.000Z');
  insertPhoto('u-dated', 'Undated', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  expect(shoots.getById('Undated')?.banner_photo_id).toBe('u-dated');
});

test('a chosen banner wins, and clearing it falls back to the first photo again', () => {
  insertShoot('Chosen', 'taken_asc');
  insertPhoto('c-early', 'Chosen', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  insertPhoto('c-late', 'Chosen', '2024-06-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');

  shoots.setBanner('Chosen', 'c-late');
  expect(shoots.getById('Chosen')?.banner_photo_id).toBe('c-late');

  shoots.setBanner('Chosen', null);
  expect(shoots.getById('Chosen')?.banner_photo_id).toBe('c-early');
});

// The count already excludes binned photos; the banner has to agree, or a row
// reading "0 photos" would still be showing one.
test('a binned photo is not the banner', () => {
  insertShoot('Binned', 'taken_asc');
  insertPhoto('b-early', 'Binned', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  insertPhoto('b-late', 'Binned', '2024-06-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z');
  db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run('b-early');
  expect(shoots.getById('Binned')?.banner_photo_id).toBe('b-late');
});

test('an empty shoot has no banner', () => {
  insertShoot('Empty', 'taken_asc');
  expect(shoots.getById('Empty')?.banner_photo_id).toBeNull();
});

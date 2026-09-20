import { Database } from '../../../db/driver';
import { beforeEach, describe, expect, it } from 'bun:test';
import { runMigrations } from '../../../db/migrate';
import { AlbumsRepository } from '../albums_repository';

let db: Database;
let repo: AlbumsRepository;

function addPhoto(id: string, taken: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, date_taken)
       VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, `${id}.arw`, taken);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES ('lib', '/photos', 'Library')`).run();
  addPhoto('early', '2026-02-01T00:00:00.000Z');
  addPhoto('late', '2026-03-01T00:00:00.000Z');
  repo = new AlbumsRepository(db);
});

describe('AlbumsRepository', () => {
  it('shows the first photo under the album ordering when no banner was chosen', () => {
    repo.insert({ id: 'a1', name: 'Faves', ordering: 'taken_desc' });
    repo.addPhotos('a1', ['early', 'late'], '2026-01-01T00:00:00.000Z');
    expect(repo.getById('a1')?.banner_photo_id).toBe('late');

    repo.updateFields('a1', { ordering: 'taken_asc' });
    expect(repo.getById('a1')?.banner_photo_id).toBe('early');
  });

  it('prefers a chosen banner, and shows nothing for an empty album', () => {
    repo.insert({ id: 'a1', name: 'Faves', ordering: 'taken_asc' });
    expect(repo.getById('a1')?.banner_photo_id).toBeNull();

    repo.addPhotos('a1', ['early', 'late'], '2026-01-01T00:00:00.000Z');
    repo.setBanner('a1', 'late');
    expect(repo.getById('a1')?.banner_photo_id).toBe('late');
    expect(repo.list()[0]?.banner_photo_id).toBe('late');
  });

  it('breaks a tie the way the grid does, so the banner is the row that opens first', () => {
    addPhoto('tied_a', '2026-02-01T00:00:00.000Z');
    addPhoto('tied_b', '2026-02-01T00:00:00.000Z');
    repo.insert({ id: 'a1', name: 'Faves', ordering: 'taken_desc' });
    repo.addPhotos('a1', ['tied_a', 'tied_b'], '2026-01-01T00:00:00.000Z');
    expect(repo.getById('a1')?.banner_photo_id).toBe('tied_b');

    repo.updateFields('a1', { ordering: 'taken_asc' });
    expect(repo.getById('a1')?.banner_photo_id).toBe('tied_a');
  });

  it('passes over a binned photo', () => {
    repo.insert({ id: 'a1', name: 'Faves', ordering: 'taken_asc' });
    repo.addPhotos('a1', ['early', 'late'], '2026-01-01T00:00:00.000Z');
    db.query(`UPDATE photos SET is_deleted = 1 WHERE id = 'early'`).run();
    expect(repo.getById('a1')?.banner_photo_id).toBe('late');
  });
});

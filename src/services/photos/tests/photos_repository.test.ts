import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../../db/migrations';
import { PhotosRepository } from '../photos_repository';

// A binned photo's file_path points into the bin at the library root, and only
// `deleted_from_path` still says which folder it came from (§12.3). Both queries
// here are keyed on a folder prefix, so both have to read the right column - and
// which one that is depends on whether the row is deleted.
const LIB = 'lib';

let db: Database;
let repo: PhotosRepository;

function insert(id: string, filePath: string, deletedFrom?: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, is_deleted, deleted_from_path)
       VALUES (?, ?, ?, 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(id, LIB, filePath, deletedFrom == null ? 0 : 1, deletedFrom ?? null);
}

function deletedFromOf(id: string): string | null {
  return (db.query('SELECT deleted_from_path FROM photos WHERE id = ?').get(id) as { deleted_from_path: string | null })
    .deleted_from_path;
}

function filePathOf(id: string): string {
  return (db.query('SELECT file_path FROM photos WHERE id = ?').get(id) as { file_path: string }).file_path;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new PhotosRepository(db);
  insert('live', 'Trip/a.arw');
  insert('binned', 'Bin/Trip/b.arw', 'Trip/b.arw');
  insert('elsewhere', 'Bin/Other/c.arw', 'Other/c.arw');
});

describe('PhotosRepository.listUnderFolder', () => {
  it('finds a binned photo by the folder it came from, not by where its file now is', () => {
    expect(repo.listUnderFolder(LIB, 'Trip').map((p) => p.id)).toEqual(['live']);
    expect(repo.listUnderFolder(LIB, 'Trip', true).map((p) => p.id).sort()).toEqual(['binned', 'live']);
    // The bin is not a folder of the library's, so asking for it finds nothing.
    expect(repo.listUnderFolder(LIB, 'Bin', true)).toEqual([]);
    expect(repo.listUnderFolder(LIB, 'Other', true).map((p) => p.id)).toEqual(['elsewhere']);
  });
});

describe('PhotosRepository.rewritePathPrefix', () => {
  it('follows a renamed folder in the live path and in where a binned photo restores to', () => {
    repo.rewritePathPrefix(LIB, 'Trip', 'Journey');

    expect(filePathOf('live')).toBe('Journey/a.arw');
    // The file did not move: the bin is at the library root, so renaming Trip on
    // disk left it exactly where it was.
    expect(filePathOf('binned')).toBe('Bin/Trip/b.arw');
    // But a restore has to put it in the folder under its new name, or it would
    // recreate the old one outside the shoot it still belongs to.
    expect(deletedFromOf('binned')).toBe('Journey/b.arw');
    expect(deletedFromOf('elsewhere')).toBe('Other/c.arw');
  });
});

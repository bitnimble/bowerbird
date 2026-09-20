import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { StackMembership } from '../../../stacks/stack_membership';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { PhotoProcessingRepository } from '../../renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../scan/photo_scan_repository';
import { PhotoPathsRepository } from '../photo_paths_repository';

// A binned photo's file_path points into the bin at the library root, and only
// `deleted_from_path` still says which folder it came from (§12.3). Both queries
// here are keyed on a folder prefix, so both have to read the right column - and
// which one that is depends on whether the row is deleted.
const LIB = 'lib';

let db: Database;
let repo: PhotoPathsRepository;
let scan: PhotoScanRepository;

function insert(id: string, filePath: string, deletedFrom?: string): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted, deleted_from_path)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(id, LIB, filePath, deletedFrom == null ? 0 : 1, deletedFrom ?? null);
}

function deletedFromOf(id: string): string | null {
  return (db.query('SELECT deleted_from_path FROM photos WHERE id = ?').get(id) as { deleted_from_path: string | null })
    .deleted_from_path;
}

function inputsOf(id: string): string[] {
  return (db.query('SELECT path FROM photo_inputs WHERE photo_id = ? ORDER BY path').all(id) as { path: string }[]).map(
    (row) => row.path,
  );
}

function filePathOf(id: string): string {
  return (
    db.query(`SELECT json_extract(recipe, '$.path') AS path FROM photos WHERE id = ?`).get(id) as { path: string }
  ).path;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repo = new PhotoPathsRepository(db, new StackMembership(db));
  scan = new PhotoScanRepository(db, new PhotoProcessingRepository(db, new RenditionsRepository(db)));
  insert('live', 'Trip/a.arw');
  insert('binned', 'Bin/Trip/b.arw', 'Trip/b.arw');
  insert('elsewhere', 'Bin/Other/c.arw', 'Other/c.arw');
});

describe('PhotoPathsRepository.listUnderFolder', () => {
  it('finds a binned photo by the folder it came from, not by where its file now is', () => {
    expect(repo.listUnderFolder(LIB, 'Trip').map((p) => p.id)).toEqual(['live']);
    expect(repo.listUnderFolder(LIB, 'Trip', true).map((p) => p.id).sort()).toEqual(['binned', 'live']);
    // The bin is not a folder of the library's, so asking for it finds nothing.
    expect(repo.listUnderFolder(LIB, 'Bin', true)).toEqual([]);
    expect(repo.listUnderFolder(LIB, 'Other', true).map((p) => p.id)).toEqual(['elsewhere']);
  });
});

describe('PhotoPathsRepository.rewritePathPrefix', () => {
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

  // The index is the scan's view of where a photograph's files are, and it is maintained by a
  // trigger rather than by this method - so a rename that moved the recipe and not the index
  // would leave the next scan reconciling a row against a path nothing is at, and marking it
  // missing.
  it('carries the input index along with the recipe it mirrors', () => {
    repo.rewritePathPrefix(LIB, 'Trip', 'Journey');

    expect(inputsOf('live')).toEqual(['Journey/a.arw']);
    expect(inputsOf('binned')).toEqual(['Bin/Trip/b.arw']);
  });
});

describe('what the catalogue knows a file feeds', () => {
  /**
   * **The propagation from a file to what depends on it.** The scan reconciles inputs rather than
   * photographs, so a file two rows are composed from is diffed once per row - which is what makes
   * a change to it reach both, rather than whichever of them a path-keyed lookup happened to find.
   */
  it('answers for every photograph an input feeds, not just one of them', () => {
    insert('second', 'Trip/a.arw');

    const rows = scan.listForScan(LIB).filter((row) => row.file_path === 'Trip/a.arw');

    expect(rows.map((row) => row.id).sort()).toEqual(['live', 'second']);
  });

  it('forgets what a photograph was composed from when the row goes', () => {
    db.query("DELETE FROM photos WHERE id = 'live'").run();

    expect(inputsOf('live')).toEqual([]);
  });

  /**
   * A row composed out of other photographs rather than imported from a file.
   *
   * It names no file, so it is in no folder and the scan has nothing to reconcile it against -
   * and that is the whole of what keeps it alive: a walk that included it would find nothing at
   * its path, read that as an absence, and mark it missing on the first pass after it was made.
   */
  it('leaves a row that names no file out of every question about paths', () => {
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES ('composed', ?, '{"kind":"panorama","version":1,"sources":[],"projection":"cylindrical"}',
                 900, 300, '2026-01-01T00:00:00.000Z')`,
    ).run(LIB);

    expect(inputsOf('composed')).toEqual([]);
    expect(scan.listForScan(LIB).map((row) => row.id)).not.toContain('composed');
    expect(repo.listUnderFolder(LIB, 'Trip').map((row) => row.id)).not.toContain('composed');
  });
});

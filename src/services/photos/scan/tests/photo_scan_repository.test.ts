import { beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { RenditionsRepository } from '../../../processing/renditions/renditions_repository';
import { PhotoProcessingRepository } from '../../renditions/photo_processing_repository';
import { PhotoScanRepository } from '../photo_scan_repository';

const LIB = 'lib';

let db: Database;
let scan: PhotoScanRepository;

function insert(
  id: string,
  row: {
    filePath?: string;
    libraryId?: string;
    hash?: string | null;
    isDeleted?: boolean;
    isMissing?: boolean;
  },
): void {
  const recipe =
    row.filePath == null
      ? JSON.stringify({ kind: 'composite', frames: [] })
      : JSON.stringify({ kind: 'file', path: row.filePath });
  db.query(
    `INSERT INTO photos (id, library_id, recipe, file_hash, width, height, date_added, is_deleted, is_missing)
       VALUES (?, ?, ?, ?, 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
  ).run(
    id,
    row.libraryId ?? LIB,
    recipe,
    row.hash === undefined ? `hash-${id}` : row.hash,
    row.isDeleted === true ? 1 : 0,
    row.isMissing === true ? 1 : 0,
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  scan = new PhotoScanRepository(
    db,
    new PhotoProcessingRepository(db, new RenditionsRepository(db)),
  );
});

test('what a library holds on disk, including its Bin', () => {
  insert('live', { filePath: 'Trip/a.arw' });
  insert('binned', { filePath: 'Bin/Trip/b.arw', isDeleted: true });
  insert('gone', { filePath: 'Trip/c.arw', isMissing: true });
  insert('unhashed', { filePath: 'Trip/d.arw', hash: null });
  insert('merged', {});
  insert('theirs', { filePath: 'Trip/e.arw', libraryId: 'other' });

  const held = scan.filesHeld(LIB).sort((a, b) => a.file_path.localeCompare(b.file_path));

  expect(held).toEqual([
    { file_hash: 'hash-binned', file_path: 'Bin/Trip/b.arw' },
    { file_hash: 'hash-live', file_path: 'Trip/a.arw' },
  ]);
});

// DESIGN §12.3: restore is the undo of soft-delete. The RAW comes back out of
// the Bin to exactly the path it was deleted from, and shoot/album membership
// survive the round trip untouched.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { PhotosService } from '../../src/services/photos/photos_service';
import type { ProcessingService } from '../../src/services/processing/processing_service';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';

const LIB = '00000000-0000-4000-8000-0000000000ba';
const SHOOT = '00000000-0000-4000-8000-0000000000bb';
const ALBUM = '00000000-0000-4000-8000-0000000000bc';
const PHOTO = '00000000-0000-4000-8000-0000000000bd';

let root: string;
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;
let service: PhotosService;

function photoRow(): { file_path: string; is_deleted: number; shoot_id: string | null } {
  return db.query('SELECT file_path, is_deleted, shoot_id FROM photos WHERE id = ?').get(PHOTO) as {
    file_path: string;
    is_deleted: number;
    shoot_id: string | null;
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-restore-'));
  mkdirSync(path.join(root, 'Trip'), { recursive: true });
  writeFileSync(path.join(root, 'Trip', 'a.arw'), 'RAW');

  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'taken_desc');
  db.query('INSERT INTO shoots (id, library_id, folder_path, name, ordering) VALUES (?, ?, ?, ?, ?)').run(
    SHOOT,
    LIB,
    'Trip',
    'Trip',
    'taken_desc',
  );
  db.query('INSERT INTO albums (id, name, ordering) VALUES (?, ?, ?)').run(ALBUM, 'Keepers', 'taken_desc');
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, file_path, width, height, date_added, needs_tile, needs_renditions)
     VALUES (?, ?, ?, 'Trip/a.arw', 100, 100, '2026-01-01T00:00:00.000Z', 0, 0)`,
  ).run(PHOTO, LIB, SHOOT);
  db.query('INSERT INTO album_photos (album_id, photo_id, date_added) VALUES (?, ?, ?)').run(
    ALBUM,
    PHOTO,
    '2026-01-01T00:00:00.000Z',
  );

  photos = new PhotosRepository(db);
  // Deleting and restoring never renders, so a stub keeps LibRaw and worker
  // threads out of these tests.
  const processing = { renderLossless: async () => {} } as unknown as ProcessingService;
  service = new PhotosService(
    photos,
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new LibrariesRepository(db),
    processing,
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('restore returns the file to the exact path it was deleted from', async () => {
  await service.delete([PHOTO]);
  expect(photoRow().is_deleted).toBe(1);
  expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(false);
  expect(existsSync(path.join(root, 'Trip', 'Bin', 'a.arw'))).toBe(true);

  await service.restore([PHOTO]);

  const row = photoRow();
  expect(row.is_deleted).toBe(0);
  expect(row.file_path).toBe('Trip/a.arw');
  expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
  expect(existsSync(path.join(root, 'Trip', 'Bin', 'a.arw'))).toBe(false);
});

test('shoot and album membership survive the delete/restore round trip', async () => {
  await service.delete([PHOTO]);
  await service.restore([PHOTO]);

  expect(photoRow().shoot_id).toBe(SHOOT);
  const albums = new AlbumsRepository(db).getAlbumIdsForPhoto(PHOTO);
  expect(albums).toEqual([ALBUM]);
});

test('restoring onto an occupied path suffixes rather than overwriting a live photo', async () => {
  await service.delete([PHOTO]);
  // Something else now sits at the original path (a re-import, say).
  writeFileSync(path.join(root, 'Trip', 'a.arw'), 'OTHER');

  await service.restore([PHOTO]);

  expect(photoRow().file_path).toBe('Trip/a_1.arw');
  // The occupying file is untouched.
  expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
  expect(existsSync(path.join(root, 'Trip', 'a_1.arw'))).toBe(true);
});

// The data directory is disposable, so a photo outside every shoot bins to the
// library root rather than under `.bowerbird` (DESIGN §12.3).
test('a photo in no shoot bins to <root>/Bin, never into the data directory', async () => {
  const LOOSE = '00000000-0000-4000-8000-0000000000be';
  writeFileSync(path.join(root, 'loose.arw'), 'RAW');
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, file_path, width, height, date_added, needs_tile, needs_renditions)
     VALUES (?, ?, NULL, 'loose.arw', 100, 100, '2026-01-01T00:00:00.000Z', 0, 0)`,
  ).run(LOOSE, LIB);

  await service.delete([LOOSE]);

  expect(existsSync(path.join(root, 'Bin', 'loose.arw'))).toBe(true);
  expect(existsSync(path.join(root, '.bowerbird', 'bin', 'loose.arw'))).toBe(false);

  await service.restore([LOOSE]);
  expect(existsSync(path.join(root, 'loose.arw'))).toBe(true);
});

test('restoring a photo that is not deleted is a no-op', async () => {
  await service.restore([PHOTO]);
  expect(photoRow().file_path).toBe('Trip/a.arw');
  expect(photoRow().is_deleted).toBe(0);
});

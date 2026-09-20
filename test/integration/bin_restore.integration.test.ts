// DESIGN §12.3: restore is the undo of soft-delete. The RAW comes back out of
// the Bin to exactly the path it was deleted from, and shoot/album membership
// survive the round trip untouched.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import type { PhotoReadService } from '../../src/services/photos/listing/photo_read_service';
import { PhotoMutationService } from '../../src/services/photos/mutations/photo_mutation_service';
import { dataPathForLibraryId } from '../../src/utils/paths';
import { photoPaths, photoState } from './helpers/photo_repositories';

const LIB = 'lib000ba';
const SHOOT = 'sht000bb';
const ALBUM = 'alb000bc';
const PHOTO = 'pht000bd';

let root: string;
let db: ReturnType<typeof createDatabase>;
let service: PhotoMutationService;

function photoRow(): { file_path: string; is_deleted: number; shoot_id: string | null } {
  return db.query(`SELECT json_extract(recipe, '$.path') AS file_path, is_deleted, shoot_id FROM photos WHERE id = ?`).get(PHOTO) as {
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
  // `bin_name` is nullable now and NULL means "no bin", so a library that bins by
  // moving has to say so (§4.1).
  db.query('INSERT INTO libraries (id, root_path, name, ordering, bin_name) VALUES (?, ?, ?, ?, ?)').run(
    LIB,
    root,
    'lib',
    'taken_desc',
    'Bin',
  );
  db.query('INSERT INTO shoots (id, library_id, folder_path, name, ordering) VALUES (?, ?, ?, ?, ?)').run(
    SHOOT,
    LIB,
    'Trip',
    'Trip',
    'taken_desc',
  );
  db.query('INSERT INTO albums (id, name, ordering) VALUES (?, ?, ?)').run(ALBUM, 'Keepers', 'taken_desc');
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, recipe, width, height, date_added)
     VALUES (?, ?, ?, '{"kind":"file","path":"Trip/a.arw"}', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(PHOTO, LIB, SHOOT);
  db.query('INSERT INTO album_photos (album_id, photo_id, date_added) VALUES (?, ?, ?)').run(
    ALBUM,
    PHOTO,
    '2026-01-01T00:00:00.000Z',
  );

  service = new PhotoMutationService(
    photoState(db),
    photoPaths(db),
    new LibrariesRepository(db),
    {} as unknown as PhotoReadService,
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
  // The one bin at the root, mirroring the folder the photo came from - not a
  // bin inside the shoot folder (§12.3).
  expect(existsSync(path.join(root, 'Trip', 'Bin'))).toBe(false);
  expect(existsSync(path.join(root, 'Bin', 'Trip', 'a.arw'))).toBe(true);

  await service.restore([PHOTO]);

  const row = photoRow();
  expect(row.is_deleted).toBe(0);
  expect(row.file_path).toBe('Trip/a.arw');
  expect(existsSync(path.join(root, 'Trip', 'a.arw'))).toBe(true);
  expect(existsSync(path.join(root, 'Bin', 'Trip', 'a.arw'))).toBe(false);
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

// The Bin holds originals, so it sits beside the photographs rather than in the
// disposable tree the data directory is (DESIGN §12.3).
test('a photo in the library root bins to <root>/Bin, never into the data directory', async () => {
  const LOOSE = 'pht000be';
  writeFileSync(path.join(root, 'loose.arw'), 'RAW');
  db.query(
    `INSERT INTO photos (id, library_id, shoot_id, recipe, width, height, date_added)
     VALUES (?, ?, NULL, '{"kind":"file","path":"loose.arw"}', 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(LOOSE, LIB);

  await service.delete([LOOSE]);

  expect(existsSync(path.join(root, 'Bin', 'loose.arw'))).toBe(true);
  // Beside the photographs, not in the tree that goes with the library: the data
  // directory is deleted wholesale (§6), and a bin inside it would take every
  // binned RAW with it.
  expect(existsSync(path.join(dataPathForLibraryId(LIB), 'bin', 'loose.arw'))).toBe(false);

  await service.restore([LOOSE]);
  expect(existsSync(path.join(root, 'loose.arw'))).toBe(true);
});

// "No move" is not "no validation". Without the existence check the row would go
// live with `is_missing` cleared and nothing behind it, and the renditions make
// the grid look fine while every original 404s.
test('restoring a photo whose file has gone raises IO_ERROR rather than going live', async () => {
  await service.delete([PHOTO]);
  rmSync(path.join(root, 'Bin', 'Trip', 'a.arw'));

  await expect(service.restore([PHOTO])).rejects.toMatchObject({ code: 'IO_ERROR' });
  expect(photoRow().is_deleted).toBe(1);
});

test('restoring a photo that is not deleted is a no-op', async () => {
  await service.restore([PHOTO]);
  expect(photoRow().file_path).toBe('Trip/a.arw');
  expect(photoRow().is_deleted).toBe(0);
});

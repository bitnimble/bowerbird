// Renaming the bin moves the folder (§4.1). The setting on its own was refused
// because it would strand every already-binned RAW in a folder the scan then
// walks straight back in; changing it and moving the folder together strands
// nothing.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { LibrariesService } from '../../src/services/libraries/libraries_service';
import { PhotosRepository } from '../../src/services/photos/photos_repository';

const LIB = 'lib000e1';
const PHOTO = 'pht000e2';

let root: string;
let db: ReturnType<typeof createDatabase>;
let libraries: LibrariesRepository;
let service: LibrariesService;

const abs = (rel: string) => path.join(root, rel);
const photoRow = () =>
  db.query('SELECT file_path, deleted_from_path FROM photos WHERE id = ?').get(PHOTO) as {
    file_path: string;
    deleted_from_path: string;
  };

function makeLibrary(binName: string | null, readOnly = false): void {
  db.query('INSERT INTO libraries (id, root_path, name, ordering, bin_name, read_only) VALUES (?, ?, ?, ?, ?, ?)').run(
    LIB,
    root,
    'lib',
    'taken_desc',
    binName,
    readOnly ? 1 : 0,
  );
  if (binName == null) return;
  mkdirSync(abs(`${binName}/Trip`), { recursive: true });
  writeFileSync(abs(`${binName}/Trip/a.arw`), 'RAW');
  const stats = statSync(abs(binName));
  libraries.setBinIdentity(LIB, { dev: stats.dev, ino: stats.ino, birthtime: stats.birthtimeMs });
  db.query(
    `INSERT INTO photos (id, library_id, file_path, deleted_from_path, width, height, date_added, is_deleted, needs_tile, needs_renditions)
     VALUES (?, ?, ?, 'Trip/a.arw', 100, 100, '2026-01-01T00:00:00.000Z', 1, 0, 0)`,
  ).run(PHOTO, LIB, `${binName}/Trip/a.arw`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-binname-'));
  db = createDatabase(':memory:');
  libraries = new LibrariesRepository(db);
  service = new LibrariesService(libraries, new PhotosRepository(db));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('renaming the bin moves the folder and re-prefixes every binned row', async () => {
  makeLibrary('Bin');
  const before = statSync(abs('Bin')).ino;

  const updated = await service.update(LIB, { bin_name: 'Rubbish' });

  expect(updated.bin_name).toBe('Rubbish');
  expect(existsSync(abs('Bin'))).toBe(false);
  expect(existsSync(abs('Rubbish/Trip/a.arw'))).toBe(true);
  // `rename` preserves the inode, which is what keeps the recorded identity good.
  expect(statSync(abs('Rubbish')).ino).toBe(before);
  expect(libraries.getBinIdentity(LIB)!.ino).toBe(before);
  // Where the photograph came from is outside the bin, and has not moved.
  expect(photoRow()).toEqual({ file_path: 'Rubbish/Trip/a.arw', deleted_from_path: 'Trip/a.arw' });
});

test('renaming to the stored name is a no-op, and onto an occupied name is a CONFLICT', async () => {
  makeLibrary('Bin');
  await expect(service.update(LIB, { bin_name: 'Bin' })).resolves.toMatchObject({ bin_name: 'Bin' });

  mkdirSync(abs('Rubbish'));
  await expect(service.update(LIB, { bin_name: 'Rubbish' })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(existsSync(abs('Bin/Trip/a.arw'))).toBe(true);
});

// The READ_ONLY check runs first, so a read-only library never sees CONFLICT.
test('a read-only library refuses the rename rather than reporting a collision', async () => {
  makeLibrary(null, true);
  mkdirSync(abs('Rubbish'));
  await expect(service.update(LIB, { bin_name: 'Rubbish' })).rejects.toMatchObject({ code: 'READ_ONLY' });
});

test('clearing read_only needs a bin name, and then makes the folder and records it', async () => {
  makeLibrary(null, true);
  await expect(service.update(LIB, { read_only: false })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

  const updated = await service.update(LIB, { read_only: false, bin_name: 'Bin' });

  expect(updated).toMatchObject({ read_only: false, bin_name: 'Bin' });
  expect(existsSync(abs('Bin'))).toBe(true);
  expect(libraries.getBinIdentity(LIB)!.ino).toBe(statSync(abs('Bin')).ino);
});

// `read_only` is applied before `bin_name`, so a request asking for both would
// commit the flag and then refuse the rename against it: a 403 saying nothing
// happened, over a library that is now read-only.
test('a request that both sets read_only and renames the bin is refused before either lands', async () => {
  makeLibrary('Bin');
  await expect(service.update(LIB, { read_only: true, bin_name: 'Rubbish' })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR',
  });
  expect(libraries.getById(LIB)).toMatchObject({ read_only: false, bin_name: 'Bin' });
  expect(existsSync(abs('Bin'))).toBe(true);
});

// A library flipped to read-only and back holds both kinds of binned row. The
// prefix rewrite is scoped to the ones actually under the bin, so the in-place
// ones - whose files are out among the photographs - must not be dragged into it.
test('renaming the bin leaves a formerly-read-only library\'s in-place rows alone', async () => {
  makeLibrary('Bin');
  const IN_PLACE = 'pht000e3';
  mkdirSync(abs('Trip'), { recursive: true });
  writeFileSync(abs('Trip/b.arw'), 'RAW');
  db.query(
    `INSERT INTO photos (id, library_id, file_path, deleted_from_path, width, height, date_added, is_deleted, needs_tile, needs_renditions)
     VALUES (?, ?, 'Trip/b.arw', 'Trip/b.arw', 100, 100, '2026-01-01T00:00:00.000Z', 1, 0, 0)`,
  ).run(IN_PLACE, LIB);

  await service.update(LIB, { bin_name: 'Rubbish' });

  // The bin-resident row moved with the folder; the in-place one did not move at
  // all, and its file is still where the photographer left it.
  expect(photoRow()).toEqual({ file_path: 'Rubbish/Trip/a.arw', deleted_from_path: 'Trip/a.arw' });
  const inPlace = db.query('SELECT file_path, deleted_from_path FROM photos WHERE id = ?').get(IN_PLACE);
  expect(inPlace).toEqual({ file_path: 'Trip/b.arw', deleted_from_path: 'Trip/b.arw' });
  expect(existsSync(abs('Trip/b.arw'))).toBe(true);
});

// Setting the flag keeps the bin: the RAWs the app already put there are still
// its own, and the bin channel goes on reconciling the folder by hand.
test('setting read_only keeps the bin folder and moves nothing', async () => {
  makeLibrary('Bin');
  const updated = await service.update(LIB, { read_only: true });

  expect(updated).toMatchObject({ read_only: true, bin_name: 'Bin' });
  expect(existsSync(abs('Bin/Trip/a.arw'))).toBe(true);
});

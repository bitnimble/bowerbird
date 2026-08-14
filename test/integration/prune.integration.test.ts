// Two paths that delete files the user did not ask about individually, so both
// need to be pinned against a real filesystem (§10.6).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { LibrariesService } from '../../src/services/libraries/libraries_service';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { PruneService } from '../../src/services/maintenance/prune_service';
import { dataPathForLibraryId } from '../../src/utils/paths';

const LIB = 'lib0ab01';
const LIVE = 'photo001';
const GONE = 'photo002';
const BINNED = 'photo003';

let root: string;
let db: ReturnType<typeof createDatabase>;
let libraries: LibrariesRepository;
let photos: PhotosRepository;

function dataDir(): string {
  return dataPathForLibraryId(LIB);
}

function seedFile(dir: string, name: string): string {
  const full = path.join(dataDir(), dir);
  mkdirSync(full, { recursive: true });
  const file = path.join(full, name);
  writeFileSync(file, 'x'.repeat(64));
  return file;
}

function insertPhoto(id: string, deleted = false): void {
  db.query(
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, is_deleted, needs_tile, needs_renditions)
     VALUES (?, ?, ?, 100, 100, '2026-01-01T00:00:00.000Z', ?, 0, 0)`,
  ).run(id, LIB, `${id}.arw`, deleted ? 1 : 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-prune-'));
  db = createDatabase(':memory:');
  libraries = new LibrariesRepository(db);
  photos = new PhotosRepository(db);
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'added_desc');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir(), { recursive: true, force: true });
});

test('prune removes generated files whose photo is gone and keeps the rest', async () => {
  insertPhoto(LIVE);
  insertPhoto(BINNED, true);

  const keptSmall = seedFile('renditions/grid', `${LIVE}.avif`);
  const keptFull = seedFile('renditions/full', `${LIVE}.avif`);
  // A binned photo keeps its row, and its renditions are what make the Bin
  // browsable, so it must survive.
  const keptBin = seedFile('renditions/grid', `${BINNED}.avif`);
  const orphanSmall = seedFile('renditions/grid', `${GONE}.avif`);
  const orphanFull = seedFile('renditions/full', `${GONE}.avif`);
  const orphanLossless = seedFile('renditions/max', `${GONE}.png`);
  // The Bin holds RAW files named by filename, not photo id: never ours to touch.
  const raw = seedFile('bin', 'DSC00001.ARW');

  const result = await new PruneService(libraries, photos).prune();

  expect(result.removed).toBe(3);
  expect(result.bytes).toBe(3 * 64);
  for (const file of [orphanSmall, orphanFull, orphanLossless]) expect(existsSync(file)).toBe(false);
  for (const file of [keptSmall, keptFull, keptBin, raw]) expect(existsSync(file)).toBe(true);
});

test('prune removes a live photo’s render left behind by an earlier output format', async () => {
  insertPhoto(LIVE);

  // The full-resolution view has been PNG, then JPEG XL, now AVIF. Each switch
  // writes a new file rather than replacing the old one, so without this the
  // superseded renders sit there forever - and it is what sweeps the WebP
  // renditions left by the move to AVIF, with no migration step to run.
  const supersededPng = seedFile('renditions/max', `${LIVE}.png`);
  const supersededJxl = seedFile('renditions/max', `${LIVE}.jxl`);
  const current = seedFile('renditions/max', `${LIVE}.avif`);

  const result = await new PruneService(libraries, photos).prune();

  expect(result.removed).toBe(2);
  expect(existsSync(supersededJxl)).toBe(false);
  expect(existsSync(supersededPng)).toBe(false);
  expect(existsSync(current)).toBe(true);
});

test('prune is a no-op when nothing is orphaned', async () => {
  insertPhoto(LIVE);
  seedFile('renditions/grid', `${LIVE}.avif`);

  expect((await new PruneService(libraries, photos).prune()).removed).toBe(0);
});

test('removing a library takes its data directory but not the photographs', async () => {
  const service = new LibrariesService(libraries, photos);
  seedFile('renditions/grid', `${LIVE}.avif`);
  const rawPhoto = path.join(root, 'DSC00001.ARW');
  writeFileSync(rawPhoto, 'raw');

  await service.delete(LIB);

  expect(existsSync(dataDir())).toBe(false);
  // The RAW files were never ours: removing a library forgets the catalogue, it
  // does not delete the photographs.
  expect(existsSync(rawPhoto)).toBe(true);
});

// The data directory holds nothing but generated files (§6), so an original
// inside it means the directory is not what it is believed to be - and this is
// the one call here that cannot be undone.
test('a data directory holding an original is left alone', async () => {
  const stray = seedFile('renditions/grid', 'DSC00001.ARW');

  await new LibrariesService(libraries, photos).delete(LIB);

  expect(existsSync(stray)).toBe(true);
});

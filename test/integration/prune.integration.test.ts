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

const LIB = '00000000-0000-4000-8000-00000000ab01';
const LIVE = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
const BINNED = '33333333-3333-4333-8333-333333333333';

let root: string;
let db: ReturnType<typeof createDatabase>;
let libraries: LibrariesRepository;
let photos: PhotosRepository;

function dataDir(): string {
  return path.join(root, '.bowerbird');
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
    `INSERT INTO photos (id, library_id, file_path, width, height, date_added, is_deleted, needs_processing)
     VALUES (?, ?, ?, 100, 100, '2026-01-01T00:00:00.000Z', ?, 0)`,
  ).run(id, LIB, `${id}.arw`, deleted ? 1 : 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-prune-'));
  db = createDatabase(':memory:');
  libraries = new LibrariesRepository(db);
  photos = new PhotosRepository(db);
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'added_desc');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('prune removes generated files whose photo is gone and keeps the rest', async () => {
  insertPhoto(LIVE);
  insertPhoto(BINNED, true);

  const keptSmall = seedFile('thumbnails/small', `${LIVE}.webp`);
  const keptFull = seedFile('thumbnails/full', `${LIVE}.webp`);
  // A binned photo keeps its row, and its thumbnails are what make the Bin
  // browsable, so it must survive.
  const keptBin = seedFile('thumbnails/small', `${BINNED}.webp`);
  const orphanSmall = seedFile('thumbnails/small', `${GONE}.webp`);
  const orphanFull = seedFile('thumbnails/full', `${GONE}.webp`);
  const orphanLossless = seedFile('lossless', `${GONE}.png`);
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

  // The full-resolution view used to be written as PNG. Switching it to JPEG XL
  // writes a new file rather than replacing the old one, so without this the
  // superseded render sits there forever: ~100MB per photo ever opened.
  const superseded = seedFile('lossless', `${LIVE}.png`);
  const current = seedFile('lossless', `${LIVE}.jxl`);

  const result = await new PruneService(libraries, photos).prune();

  expect(result.removed).toBe(1);
  expect(existsSync(superseded)).toBe(false);
  expect(existsSync(current)).toBe(true);
});

test('prune is a no-op when nothing is orphaned', async () => {
  insertPhoto(LIVE);
  seedFile('thumbnails/small', `${LIVE}.webp`);

  expect((await new PruneService(libraries, photos).prune()).removed).toBe(0);
});

test('removing a library takes its data directory but not the photographs', async () => {
  const service = new LibrariesService(libraries);
  seedFile('thumbnails/small', `${LIVE}.webp`);
  const rawPhoto = path.join(root, 'DSC00001.ARW');
  writeFileSync(rawPhoto, 'raw');

  await service.delete(LIB);

  expect(existsSync(dataDir())).toBe(false);
  // The RAW files were never ours: removing a library forgets the catalogue, it
  // does not delete the photographs.
  expect(existsSync(rawPhoto)).toBe(true);
});

test('a data directory that contains the library root is left alone', async () => {
  // A library configured this way keeps its generated files among the
  // photographs; removing that directory would take the originals with it.
  const nested = path.join(root, 'photos');
  mkdirSync(nested, { recursive: true });
  const rawPhoto = path.join(nested, 'DSC00001.ARW');
  writeFileSync(rawPhoto, 'raw');
  db.query('UPDATE libraries SET root_path = ?, data_path = ? WHERE id = ?').run(nested, root, LIB);

  await new LibrariesService(libraries).delete(LIB);

  expect(existsSync(rawPhoto)).toBe(true);
  expect(existsSync(root)).toBe(true);
});

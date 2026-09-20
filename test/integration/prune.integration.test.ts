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
import type { PhotoMetadataRepository } from '../../src/services/photos/metadata/photo_metadata_repository';
import type { PhotoPathsRepository } from '../../src/services/photos/paths/photo_paths_repository';
import type { PhotoScanRepository } from '../../src/services/photos/scan/photo_scan_repository';
import { photoMetadata, photoPaths, photoScan } from './helpers/photo_repositories';
import { PruneService } from '../../src/services/maintenance/prune_service';
import { dataPathForLibraryId } from '../../src/utils/paths';

const LIB = 'lib0ab01';
const LIVE = 'photo001';
const GONE = 'photo002';
const BINNED = 'photo003';

let root: string;
let db: ReturnType<typeof createDatabase>;
let libraries: LibrariesRepository;
let metadata: PhotoMetadataRepository;
let paths: PhotoPathsRepository;
let scan: PhotoScanRepository;

function pruning(): PruneService {
  return new PruneService(libraries, metadata);
}

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
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_deleted)
     VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, LIB, `${id}.arw`, deleted ? 1 : 0);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-prune-'));
  db = createDatabase(':memory:');
  libraries = new LibrariesRepository(db);
  metadata = photoMetadata(db);
  paths = photoPaths(db);
  scan = photoScan(db);
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
  // `.jxl` rather than `.png`: PNG is an importable original now, so a stray one under
  // `renditions/` is refused by `deleteGeneratedFile` precisely because it cannot be told from a
  // photograph someone put there.
  const orphanLossless = seedFile('renditions/max', `${GONE}.jxl`);
  // The Bin holds RAW files named by filename, not photo id: never ours to touch.
  const raw = seedFile('bin', 'DSC00001.ARW');

  const result = await pruning().prune();

  expect(result.removed).toBe(3);
  expect(result.bytes).toBe(3 * 64);
  for (const file of [orphanSmall, orphanFull, orphanLossless]) expect(existsSync(file)).toBe(false);
  for (const file of [keptSmall, keptFull, keptBin, raw]) expect(existsSync(file)).toBe(true);
});

test('prune removes a live photo’s render left behind by an earlier output format', async () => {
  insertPhoto(LIVE);

  // The full-resolution view has been WebP, then JPEG XL, now AVIF. Each switch
  // writes a new file rather than replacing the old one, so without this the
  // superseded renders sit there forever, with no migration step to run.
  //
  // Not PNG, though it was one of those formats: PNG is an importable original now, so one under
  // `renditions/` is refused rather than swept - it cannot be told from a photograph put there by
  // hand, and the two mistakes are not the same size.
  const supersededWebp = seedFile('renditions/max', `${LIVE}.webp`);
  const supersededJxl = seedFile('renditions/max', `${LIVE}.jxl`);
  const current = seedFile('renditions/max', `${LIVE}.avif`);

  const result = await pruning().prune();

  expect(result.removed).toBe(2);
  expect(existsSync(supersededJxl)).toBe(false);
  expect(existsSync(supersededWebp)).toBe(false);
  expect(existsSync(current)).toBe(true);
});

// A panorama is a photograph, so its copies are kept and swept by the rule every photograph's
// are - which is the point: the sweep has nothing to know about one.
test('prune keeps a panorama’s copies while the photograph is there, and takes them when it goes', async () => {
  const panorama = 'panorama001';
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, '{"kind":"panorama","version":1,"sources":[],"projection":"cylindrical"}',
               9000, 4000, '2026-01-01T00:00:00.000Z')`,
  ).run(panorama, LIB);
  const tile = seedFile('renditions/grid', `${panorama}.avif`);
  const picture = seedFile('renditions/full-hdr', `${panorama}.avif`);

  expect((await pruning().prune()).removed).toBe(0);
  expect(existsSync(tile)).toBe(true);
  expect(existsSync(picture)).toBe(true);

  db.query('DELETE FROM photos WHERE id = ?').run(panorama);
  expect((await pruning().prune()).removed).toBe(2);
  expect(existsSync(tile)).toBe(false);
  expect(existsSync(picture)).toBe(false);
});

test('prune is a no-op when nothing is orphaned', async () => {
  insertPhoto(LIVE);
  seedFile('renditions/grid', `${LIVE}.avif`);

  expect((await pruning().prune()).removed).toBe(0);
});

test('removing a library takes its data directory but not the photographs', async () => {
  const service = new LibrariesService(libraries, scan, paths);
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

  await new LibrariesService(libraries, scan, paths).delete(LIB);

  expect(existsSync(stray)).toBe(true);
});

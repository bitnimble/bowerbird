// The scan builds each grid tile while it holds the RAW open, and the row it becomes takes that
// tile on by rename (§10.4). End to end over a real RAW, because the whole claim is about what
// one open of a real file produces.
//   docker exec bowerbird-dev bun test test/integration
process.env.DATA_DIR = `${process.env.TMPDIR ?? '/tmp'}/bb-fused-tile-data`;

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';
import { ProcessingService } from '../../src/services/processing/pipeline/processing_service';
import { photoListing, photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';
import { extractMetadata } from '../../src/services/processing/analysis/metadata';
import { DEFAULT_SETTINGS } from '../../src/schemas/settings';
import { dataPathForLibraryId } from '../../src/utils/paths';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib000fu';

let root: string;
let db: ReturnType<typeof createDatabase>;
let scan: ScanService;
let processing: ProcessingService;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-fused-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  const photoProcessingRepo = photoProcessing(db);
  const paths = photoPaths(db);
  processing = new ProcessingService(
    photoProcessingRepo,
    paths,
    photoListing(db),
    { get: () => DEFAULT_SETTINGS } as SettingsRepository,
  );
  scan = new ScanService(
    photoScan(db, photoProcessingRepo),
    paths,
    photoMetadata(db, photoProcessingRepo),
    photoProcessingRepo,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    {
      // The rendition batch is not what this is about, and running it would render the file.
      processUnprocessed() {},
      tileEncoding: () => processing.tileEncoding(),
      adoptScannedTile: (photoId, dataPath, staged) => processing.adoptScannedTile(photoId, dataPath, staged),
      discardScannedTile: (staged) => processing.discardScannedTile(staged),
    },
    extractMetadata,
  );
  copyFileSync(FIXTURE, path.join(root, 'p.arw'));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
});

test('the tile the scan built lands under the id the insert minted', async () => {
  await scan.scanLibrary(LIB);

  const photo = db
    .query(
      `SELECT p.id, r.needs_build AS needs_tile, r.built_at AS tile_built_at
         FROM photos p JOIN renditions r ON r.photo_id = p.id AND r.variant = 'grid'`,
    )
    .get() as {
    id: string;
    needs_tile: number;
    tile_built_at: string | null;
  };
  const grid = path.join(dataPathForLibraryId(LIB), 'renditions', 'grid');

  expect(existsSync(path.join(grid, `${photo.id}.avif`))).toBe(true);
  expect(statSync(path.join(grid, `${photo.id}.avif`)).size).toBeGreaterThan(0);
  // The row has to say so as well: a tile on disk under a photo that still owes one is a tile
  // the rendition pass builds again, which is the whole cost this was meant to remove.
  expect(photo.needs_tile).toBe(0);
  expect(photo.tile_built_at).not.toBeNull();
  // The name the scan minted is gone - renamed, not copied - and nothing else is left beside it.
  expect(readdirSync(grid)).toEqual([`${photo.id}.avif`]);
});

test('a stopped scan leaves none of its tiles behind', async () => {
  // A stop is a supported action, not a crash, and it unwinds long before the run reaches the
  // point where tiles are claimed. Left alone, everything the scan had already built would sit
  // in `grid/` under minted names until the orphan sweep came round - a week, by default.
  const stopping = mkdtempSync(path.join(tmpdir(), 'bb-fused-stop-'));
  const db2 = createDatabase(':memory:');
  const LIB2 = 'lib000st';
  // Before, not only after: this test asserts on what is in that directory, so anything a
  // previous run left there when it failed would be counted as this run's leftovers.
  rmSync(dataPathForLibraryId(LIB2), { recursive: true, force: true });
  db2.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB2, stopping, 'stop', 'taken_desc');
  const photoProcessingRepo2 = photoProcessing(db2);
  const paths2 = photoPaths(db2);
  const processing2 = new ProcessingService(
    photoProcessingRepo2,
    paths2,
    photoListing(db2),
    { get: () => DEFAULT_SETTINGS } as SettingsRepository,
  );
  for (const name of ['a.arw', 'b.arw', 'c.arw']) copyFileSync(FIXTURE, path.join(stopping, name));

  // Stops once a file has been read, but only after the library has rows: a *first* scan
  // commits its batches as it goes and finishes normally, where a populated one applies in one
  // closing transaction and unwinds through `ScanCancelled` - which is the path that skips
  // everything after the apply.
  let stopAfterRead = false;
  const sync2 = new ScanService(
    photoScan(db2, photoProcessingRepo2),
    paths2,
    photoMetadata(db2, photoProcessingRepo2),
    photoProcessingRepo2,
    new LibrariesRepository(db2),
    new AlbumsRepository(db2),
    new ShootsRepository(db2),
    new FolderRulesRepository(db2),
    new SyncLocksRepository(db2),
    {
      processUnprocessed() {},
      tileEncoding: () => processing2.tileEncoding(),
      adoptScannedTile: (id, dataPath, staged) => processing2.adoptScannedTile(id, dataPath, staged),
      discardScannedTile: (staged) => processing2.discardScannedTile(staged),
    },
    async (abs, stage) => {
      const metadata = await extractMetadata(abs, stage);
      if (stopAfterRead) sync2.cancelScan(LIB2);
      return metadata;
    },
  );

  await sync2.scanLibrary(LIB2);
  const settled = db2.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number };

  stopAfterRead = true;
  for (const name of ['d.arw', 'e.arw']) copyFileSync(FIXTURE, path.join(stopping, name));
  await sync2.scanLibrary(LIB2);

  const grid = path.join(dataPathForLibraryId(LIB2), 'renditions', 'grid');
  // Nothing was applied, so the stopped run added no rows - and left no tile of its own either.
  expect(db2.query('SELECT COUNT(*) AS n FROM photos').get()).toEqual(settled);
  expect(readdirSync(grid).length).toBe(settled.n);
  db2.close();
  rmSync(stopping, { recursive: true, force: true });
  rmSync(dataPathForLibraryId(LIB2), { recursive: true, force: true });
});

test('and so does one that arrives in a library that already has rows', async () => {
  // The other insert path. A first scan writes its photos down in batches and builds its own
  // `AddedEntry`; every later scan goes through `buildDiff` instead, and the tile has to be
  // carried by both - threading only one is a fused import that works exactly until the second
  // time you use it.
  copyFileSync(FIXTURE, path.join(root, 'q.arw'));

  await scan.scanLibrary(LIB);

  const added = db
    .query(
      `SELECT p.id, r.needs_build AS needs_tile
         FROM photos p JOIN renditions r ON r.photo_id = p.id AND r.variant = 'grid'
         WHERE json_extract(p.recipe, '$.path') = 'q.arw'`,
    )
    .get() as {
    id: string;
    needs_tile: number;
  };
  const grid = path.join(dataPathForLibraryId(LIB), 'renditions', 'grid');
  expect(existsSync(path.join(grid, `${added.id}.avif`))).toBe(true);
  expect(added.needs_tile).toBe(0);
  expect(readdirSync(grid).length).toBe(2);
});

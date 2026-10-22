// What a run reports while it is going, and what stopping it does. Both phases
// are covered: the scan, which counts its way through the files and, stopped, keeps
// only the new photos it wrote down as it went, and the detached
// processing tail, which stops handing out jobs and settles back to idle.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import type { MediaListing } from '../../src/services/libraries/media_listing';
import {
  photoMetadata,
  photoPaths,
  photoProcessing,
  photoScan,
} from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import type { SidecarImporter } from '../../src/services/sync/scan/scan_batch';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import type { ProcessingTrigger } from '../../src/services/sync/scan/scan_rebuilds';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';

const LIB = 'lib000ce';
const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 10));

let root: string;
let db: ReturnType<typeof createDatabase>;

interface Hooks {
  /** Asked just before the stat pass. */
  scanConcurrency?: () => number;
  /** Asked after each committed batch of new photos. */
  sidecars?: SidecarImporter;
  /** Asked once the stat pass is done, before anything it found is kept. */
  media?: MediaListing;
}

function build(processing: ProcessingTrigger, hooks: Hooks = {}): ScanService {
  const photoProcessingRepo = photoProcessing(db);
  return new ScanService(
    photoScan(db, photoProcessingRepo),
    photoPaths(db),
    photoMetadata(db, photoProcessingRepo),
    photoProcessingRepo,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    processing,
    hooks.sidecars,
    hooks.scanConcurrency,
    undefined,
    undefined,
    hooks.media,
  );
}

function afterStatting(then: () => void): MediaListing {
  return {
    under: async () => {
      then();
      return null;
    },
    queueThumbnail: async () => null,
  };
}

function afterEachBatch(then: () => void): SidecarImporter {
  return {
    importFor: () => {
      then();
      return 0;
    },
  };
}

function addBatchOfFiles(): void {
  for (let i = 0; i < 1001; i++) writeFileSync(path.join(root, `f${i}.arw`), `f${i}`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-cancel-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(
    LIB,
    root,
    'lib',
    'taken_desc',
  );
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('the scan counts its way through the files it stats', async () => {
  const seen: [number, number][] = [];
  const look = (): void => {
    const status = scan.getScanStatus(LIB);
    expect(status.status).toBe('processing');
    seen.push([status.photos_scanned, status.photos_to_scan]);
  };
  const scan: ScanService = build(
    { processUnprocessed: () => {} },
    {
      scanConcurrency: () => {
        look();
        return 1;
      },
      media: afterStatting(look),
    },
  );

  const status = await scan.scanLibrary(LIB);

  expect(seen).toEqual([
    [0, 3],
    [3, 3],
  ]);
  // Over, so the two settle on what was found and the phase moves on.
  expect(status.status).toBe('rendition');
  expect(status.photos_scanned).toBe(3);
  expect(status.photos_to_scan).toBe(3);
});

test('a stopped first scan keeps the photos it did reach', async () => {
  // Nothing in the catalogue for the half-built picture to contradict, so what it
  // holds is "these files are new" and stays true however much it did not see.
  // The alternative is throwing away every file a stopped 50k import had read.
  addBatchOfFiles();
  const scan: ScanService = build(
    { processUnprocessed: () => {} },
    { sidecars: afterEachBatch(() => scan.cancelScan(LIB)) },
  );

  const status = await scan.scanLibrary(LIB);

  expect(status.photos_added).toBe(1000);
  expect(db.query('SELECT COUNT(*) AS n FROM photos').get()).toEqual({ n: 1000 });
  // None marked missing: the file it never reached is simply not in the catalogue
  // yet, which is what the next scan adds.
  expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE is_missing = 1').get()).toEqual({ n: 0 });
});

test('stopping a rescan keeps the new photos it reached and applies nothing else', async () => {
  await build({ processUnprocessed: () => {} }).scanLibrary(LIB);
  const before = db
    .query(`SELECT id, file_hash FROM photos ORDER BY json_extract(recipe, '$.path')`)
    .all();
  expect(before).toHaveLength(3);

  // More than a batch of new files, so the stop lands between a committed batch and the rest.
  addBatchOfFiles();

  const stopped: ScanService = build(
    { processUnprocessed: () => {} },
    { sidecars: afterEachBatch(() => stopped.cancelScan(LIB)) },
  );
  const status = await stopped.scanLibrary(LIB);

  expect(status.status).toBe('idle');
  expect(status.photos_scanned).toBe(0);
  // The 3 rows untouched and none marked missing, which is what applying the truncated
  // scan's picture would have done; the batch it committed is kept.
  const after = db
    .query(`SELECT id, file_hash FROM photos ORDER BY json_extract(recipe, '$.path')`)
    .all();
  expect(after.slice(0, 3)).toEqual(before);
  expect(after).toHaveLength(1003);
  expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE is_missing = 1').get()).toEqual({ n: 0 });
});

test('stopping a rescan with a file gone applies nothing, since a new file may be its move', async () => {
  await build({ processUnprocessed: () => {} }).scanLibrary(LIB);
  const before = db
    .query(`SELECT id, file_hash FROM photos ORDER BY json_extract(recipe, '$.path')`)
    .all();

  rmSync(path.join(root, 'a.arw'));
  writeFileSync(path.join(root, 'd.arw'), 'd.arw');

  const stopped: ScanService = build(
    { processUnprocessed: () => {} },
    { media: afterStatting(() => stopped.cancelScan(LIB)) },
  );
  await stopped.scanLibrary(LIB);

  expect(
    db.query(`SELECT id, file_hash FROM photos ORDER BY json_extract(recipe, '$.path')`).all(),
  ).toEqual(before);
  expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE is_missing = 1').get()).toEqual({ n: 0 });
});

test('stopping during processing ends the run rather than waiting it out', async () => {
  const asked: (() => boolean)[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const scan: ScanService = build(
    // Stands in for the worker pool, which asks between jobs whether to carry on.
    {
      processUnprocessed: (_libraryId, stopped) => {
        if (stopped) asked.push(stopped);
        return blocked;
      },
    },
  );

  const status = await scan.scanLibrary(LIB);
  expect(status.status).toBe('rendition');
  expect(status.photos_added).toBe(3);
  expect(asked[0]?.()).toBe(false);
  expect(scan.getScanStatus(LIB).status).toBe('rendition');

  scan.cancelScan(LIB);
  expect(asked[0]?.()).toBe(true); // the pool is told at its next job

  release();
  await flush();

  expect(scan.getScanStatus(LIB).status).toBe('idle');
  // The photos it never reached keep their flags, so the next scan picks them up.
  expect(scan.getScanStatus(LIB).photos_processing).toBe(3);
});

test('a batch a later scan coalesced into is still what a stop reaches', async () => {
  // A batch is per library and outlives the scan that started it, so a second scan
  // joins the running one (ProcessingService dedups by library) and whatever it
  // handed over is dropped. Asked for a fixed answer, the batch would go on
  // watching the finished scan, and Stop would do nothing at all.
  const asked: (() => boolean)[] = [];
  const scan: ScanService = build({
    processUnprocessed: (_libraryId, stopped) => {
      if (stopped) asked.push(stopped);
    },
  });

  await scan.scanLibrary(LIB); // the generation whose batch is running
  await scan.scanLibrary(LIB); // a later one, which would join that batch
  await flush();

  scan.cancelScan(LIB); // aimed at the newer generation
  expect(asked[0]?.()).toBe(true); // and answered by the batch the older one started
});

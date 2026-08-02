// What a run reports while it is going, and what stopping it does. Both phases
// are covered: the scan, which counts its way through the files and abandons its
// work if stopped because nothing has been applied yet, and the detached
// processing tail, which stops handing out jobs and settles back to idle.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import type { FileMetadata } from '../../src/services/processing/metadata';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService, type ProcessingTrigger } from '../../src/services/sync/sync_service';

const LIB = '00000000-0000-4000-8000-0000000000ce';
const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 10));

// The files never get opened: the extractor is injected, and the hash is computed
// from its answer rather than from the bytes.
function metadata(mtime: Date, size: number): FileMetadata {
  return {
    width: 100,
    height: 100,
    colorSpace: 'sRGB',
    orientation: 0,
    dateTaken: null,
    dateTakenOffset: null,
    latitude: null,
    longitude: null,
    iso: null,
    shutterSpeed: null,
    aperture: null,
    focalLength: null,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    mtime: mtime.toISOString(),
    fileSize: size,
  };
}

let root: string;
let db: ReturnType<typeof createDatabase>;

function build(processing: ProcessingTrigger, extract: (absPath: string) => Promise<FileMetadata>): SyncService {
  return new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    processing,
    extract,
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-cancel-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('the scan counts its way through the files it will open', async () => {
  const seen: [number, number][] = [];
  const sync: SyncService = build({ processUnprocessed: () => {} }, async () => {
    const status = sync.getSyncStatus(LIB);
    expect(status.status).toBe('scanning');
    seen.push([status.photos_scanned, status.photos_to_scan]);
    return metadata(new Date(), 3);
  });

  const status = await sync.syncLibrary(LIB);

  // Read at the top of each file's turn, so the last one is still outstanding.
  expect(seen).toEqual([
    [0, 3],
    [1, 3],
    [2, 3],
  ]);
  // Over, so the two settle on what was found and the phase moves on.
  expect(status.status).toBe('processing');
  expect(status.photos_scanned).toBe(3);
  expect(status.photos_to_scan).toBe(3);
});

test('a stopped first scan keeps the photos it did reach', async () => {
  // Nothing in the catalogue for the half-built picture to contradict, so what it
  // holds is "these files are new" and stays true however much it did not see.
  // The alternative is throwing away every file a stopped 50k import had read.
  let scanned = 0;
  const sync: SyncService = build({ processUnprocessed: () => {} }, async () => {
    if (++scanned === 2) sync.cancelSync(LIB); // stop with the third still to read
    return metadata(new Date(), 3);
  });

  const status = await sync.syncLibrary(LIB);

  expect(scanned).toBe(2); // the third was never opened
  expect(status.photos_added).toBe(2);
  expect(db.query('SELECT COUNT(*) AS n FROM photos').get()).toEqual({ n: 2 });
  // None marked missing: the file it never reached is simply not in the catalogue
  // yet, which is what the next sync adds.
  expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE is_missing = 1').get()).toEqual({ n: 0 });
});

test('stopping a rescan applies nothing, because a half-built scan reads as deletions', async () => {
  const sync: SyncService = build({ processUnprocessed: () => {} }, async () => metadata(new Date(), 3));
  await sync.syncLibrary(LIB);
  const before = db.query('SELECT id, file_hash FROM photos ORDER BY file_path').all();
  expect(before).toHaveLength(3);

  // A fourth file to be found, so there is something for a partial run to apply.
  writeFileSync(path.join(root, 'd.arw'), 'd.arw');

  let scanned = 0;
  const stopped: SyncService = build({ processUnprocessed: () => {} }, async () => {
    if (++scanned === 1) stopped.cancelSync(LIB);
    return metadata(new Date(), 3);
  });
  const status = await stopped.syncLibrary(LIB);

  expect(status.status).toBe('idle');
  expect(status.photos_scanned).toBe(0);
  // Untouched: no fourth row, and no row marked missing for the files it never
  // reached, which is what applying the truncated scan would have done.
  expect(db.query('SELECT id, file_hash FROM photos ORDER BY file_path').all()).toEqual(before);
  expect(db.query('SELECT COUNT(*) AS n FROM photos WHERE is_missing = 1').get()).toEqual({ n: 0 });
});

test('stopping during processing ends the run rather than waiting it out', async () => {
  const asked: (() => boolean)[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const sync: SyncService = build(
    // Stands in for the worker pool, which asks between jobs whether to carry on.
    {
      processUnprocessed: (_libraryId, stopped) => {
        if (stopped) asked.push(stopped);
        return blocked;
      },
    },
    async () => metadata(new Date(), 3),
  );

  const status = await sync.syncLibrary(LIB);
  expect(status.status).toBe('processing');
  expect(status.photos_added).toBe(3);
  expect(asked[0]?.()).toBe(false);
  expect(sync.getSyncStatus(LIB).status).toBe('processing');

  sync.cancelSync(LIB);
  expect(asked[0]?.()).toBe(true); // the pool is told at its next job

  release();
  await flush();

  expect(sync.getSyncStatus(LIB).status).toBe('idle');
  // The photos it never reached keep their flags, so the next sync picks them up.
  expect(sync.getSyncStatus(LIB).photos_processing).toBe(3);
});

test('a batch a later sync coalesced into is still what a stop reaches', async () => {
  // A batch is per library and outlives the sync that started it, so a second sync
  // joins the running one (ProcessingService dedups by library) and whatever it
  // handed over is dropped. Asked for a fixed answer, the batch would go on
  // watching the finished sync, and Stop would do nothing at all.
  const asked: (() => boolean)[] = [];
  const sync: SyncService = build(
    {
      processUnprocessed: (_libraryId, stopped) => {
        if (stopped) asked.push(stopped);
      },
    },
    async () => metadata(new Date(), 3),
  );

  await sync.syncLibrary(LIB); // the generation whose batch is running
  await sync.syncLibrary(LIB); // a later one, which would join that batch
  await flush();

  sync.cancelSync(LIB); // aimed at the newer generation
  expect(asked[0]?.()).toBe(true); // and answered by the batch the older one started
});

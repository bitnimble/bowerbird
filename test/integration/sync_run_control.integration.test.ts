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
    processing,
    extract,
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-cancel-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'taken_desc');
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

test('stopping mid-scan applies nothing and leaves the library idle', async () => {
  let scanned = 0;
  let processingRuns = 0;
  const sync: SyncService = build(
    { processUnprocessed: () => void processingRuns++ },
    async () => {
      if (scanned++ === 0) sync.cancelSync(LIB); // stop while there are files still to read
      return metadata(new Date(), 3);
    },
  );

  const status = await sync.syncLibrary(LIB);

  expect(status.status).toBe('idle');
  expect(status.photos_scanned).toBe(0);
  expect(scanned).toBe(1); // the remaining files were never opened
  expect(processingRuns).toBe(0); // nothing was applied, so nothing to process
  expect(db.query('SELECT COUNT(*) AS n FROM photos').get()).toEqual({ n: 0 });
  expect(sync.getSyncStatus(LIB).status).toBe('idle');
});

test('stopping during processing ends the run rather than waiting it out', async () => {
  let signalled: AbortSignal | null = null;
  const sync: SyncService = build(
    {
      // Stands in for the worker pool: runs until the signal says to stop.
      processUnprocessed: (_libraryId, signal) => {
        signalled = signal ?? null;
        return new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      },
    },
    async () => metadata(new Date(), 3),
  );

  const status = await sync.syncLibrary(LIB);
  expect(status.status).toBe('processing');
  expect(status.photos_added).toBe(3);
  expect(signalled).not.toBeNull();
  expect(sync.getSyncStatus(LIB).status).toBe('processing');

  sync.cancelSync(LIB);
  await flush();

  expect(sync.getSyncStatus(LIB).status).toBe('idle');
  // The photos it never reached keep their flags, so the next sync picks them up.
  expect(sync.getSyncStatus(LIB).photos_processing).toBe(3);
});

// What a killed process leaves behind, and what the next one does with it: a
// first scan commits as it goes (§9.4), a scoped run hands its rendition batch
// only the files it reconciled (§9.5), and a fresh process reports the backlog
// rather than a flat idle (§9.6).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import type { FileMetadata } from '../../src/services/processing/metadata';
import type { ProcessingScope } from '../../src/services/processing/processing_service';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService, type ProcessingTrigger } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';

const LIB = '00000000-0000-4000-8000-0000000000ce';

// The files are never opened: the extractor is injected, and the hash comes off
// its answer rather than the bytes. mtime and size are the file's real ones, so
// a second scan sees an untouched file as unchanged rather than modified.
function metadata(absPath: string): FileMetadata {
  const stats = statSync(absPath);
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
    mtime: stats.mtime.toISOString(),
    fileSize: stats.size,
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
    new SyncLocksRepository(db),
    processing,
    extract,
  );
}

function count(): number {
  return (db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-resume-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a first scan writes its photos down as it goes, not all at the end', async () => {
  // One past the batch size, so the batch has to land while the scan is still
  // running. A kill at this point costs the tail, not the hours before it.
  for (let i = 0; i < 1001; i++) writeFileSync(path.join(root, `f${i}.arw`), `f${i}`);

  const midScan: number[] = [];
  let opened = 0;
  const sync: SyncService = build({ processUnprocessed: () => {} }, async (absPath) => {
    if (++opened === 1001) midScan.push(count());
    return metadata(absPath);
  });

  const status = await sync.syncLibrary(LIB);

  expect(midScan).toEqual([1000]);
  expect(status.photos_added).toBe(1001);
  expect(count()).toBe(1001);
});

test('a scoped run hands the rendition batch its own files, not the library backlog', async () => {
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);

  const scopes: (ProcessingScope | undefined)[] = [];
  const sync: SyncService = build(
    { processUnprocessed: (scope) => void scopes.push(scope) },
    async (absPath) => metadata(absPath),
  );

  // A full run, whose photos nothing then processes: the backlog a scoped run
  // must not adopt.
  await sync.syncLibrary(LIB);
  expect(scopes[0]?.photoIds).toBeUndefined(); // full run: the whole library
  const photos = new PhotosRepository(db);
  expect(photos.countPendingProcessing(LIB)).toBe(3);

  writeFileSync(path.join(root, 'd.arw'), 'd.arw');
  const status = await sync.syncLibrary(LIB, ['d.arw']);

  expect(status.photos_added).toBe(1);
  const added = db.query('SELECT id FROM photos WHERE file_path = ?').get('d.arw') as { id: string };
  expect(scopes[1]?.photoIds).toEqual([added.id]);
  // The status counts that run's own work too, or one changed file would report
  // itself as four renditions outstanding.
  expect(status.photos_processing).toBe(1);
});

test('a fresh process reports the work the last one left, without starting it', async () => {
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);
  await build({ processUnprocessed: () => {} }, async (absPath) => metadata(absPath)).syncLibrary(LIB);

  // Stands in for the restart: same database, no in-memory status at all.
  let asked = 0;
  const restarted = build({ processUnprocessed: () => void asked++ }, async (absPath) => metadata(absPath));
  const status = restarted.getSyncStatus(LIB);

  expect(status.status).toBe('idle');
  expect(status.photos_processing).toBe(3);
  expect(asked).toBe(0); // reading the status is not a trigger
});

// What a killed process leaves behind, and what the next one does with it: a
// first scan commits as it goes (§9.4), a scoped run hands its rendition batch
// only the files it reconciled (§9.5), and a fresh process reports the backlog
// rather than a flat idle (§9.6).
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import type { ProcessingScope } from '../../src/services/processing/pipeline/processing_service';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
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

let root: string;
let db: ReturnType<typeof createDatabase>;

function build(processing: ProcessingTrigger, sidecars?: SidecarImporter): ScanService {
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
    sidecars,
  );
}

function count(): number {
  return (db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;
}

// The sidecar import runs once after each commit of inserted rows, so it sees each batch land.
function recordingCommits(): { committed: number[]; sidecars: SidecarImporter } {
  const committed: number[] = [];
  return {
    committed,
    sidecars: {
      importFor: () => {
        committed.push(count());
        return 0;
      },
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-resume-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(
    LIB,
    root,
    'lib',
    'taken_desc',
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a first scan writes its photos down as it goes, not all at the end', async () => {
  // One past the batch size, so the batch has to land while the scan is still
  // running. A kill at this point costs the tail, not the hours before it.
  for (let i = 0; i < 1001; i++) writeFileSync(path.join(root, `f${i}.arw`), `f${i}`);

  const { committed, sidecars } = recordingCommits();
  const status = await build({ processUnprocessed: () => {} }, sidecars).scanLibrary(LIB);

  expect(committed).toEqual([1000, 1001]);
  expect(status.photos_added).toBe(1001);
  expect(count()).toBe(1001);
});

test('an import resumed after a stop still writes its photos down as it goes', async () => {
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);
  await build({ processUnprocessed: () => {} }).scanLibrary(LIB);
  for (let i = 0; i < 1001; i++) writeFileSync(path.join(root, `f${i}.arw`), `f${i}`);

  const { committed, sidecars } = recordingCommits();
  const status = await build({ processUnprocessed: () => {} }, sidecars).scanLibrary(LIB);

  expect(committed).toEqual([1003, 1004]);
  expect(status.photos_added).toBe(1001);
  expect(count()).toBe(1004);
});

test('a scan that misses a row holds its new files back for the move they may be', async () => {
  writeFileSync(path.join(root, 'a.arw'), 'a.arw');
  await build({ processUnprocessed: () => {} }).scanLibrary(LIB);
  const before = db.query('SELECT id FROM photos').get() as { id: string };
  renameSync(path.join(root, 'a.arw'), path.join(root, 'moved.arw'));
  for (let i = 0; i < 1001; i++) writeFileSync(path.join(root, `f${i}.arw`), `f${i}`);

  const { committed, sidecars } = recordingCommits();
  await build({ processUnprocessed: () => {} }, sidecars).scanLibrary(LIB);

  expect(committed).toEqual([1002]);
  expect(count()).toBe(1002);
  const moved = db
    .query(`SELECT id, is_missing FROM photos WHERE json_extract(recipe, '$.path') = ?`)
    .get('moved.arw');
  expect(moved).toEqual({ id: before.id, is_missing: 0 });
});

test('a scoped run hands the rendition batch its own files, not the library backlog', async () => {
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);

  const scopes: (ProcessingScope | undefined)[] = [];
  const scan: ScanService = build({ processUnprocessed: (scope) => void scopes.push(scope) });

  // A full run, whose photos nothing then processes: the backlog a scoped run
  // must not adopt.
  await scan.scanLibrary(LIB);
  expect(scopes[0]?.photoIds).toBeUndefined(); // full run: the whole library
  const photos = photoProcessing(db);
  expect(photos.countPendingProcessing(LIB)).toBe(3);

  writeFileSync(path.join(root, 'd.arw'), 'd.arw');
  const status = await scan.scanLibrary(LIB, { paths: ['d.arw'] });

  expect(status.photos_added).toBe(1);
  const added = db
    .query(`SELECT id FROM photos WHERE json_extract(recipe, '$.path') = ?`)
    .get('d.arw') as { id: string };
  expect(scopes[1]?.photoIds).toEqual([added.id]);
  // The status counts that run's own work too, or one changed file would report
  // itself as four renditions outstanding.
  expect(status.photos_processing).toBe(1);
});

test('a fresh process reports the work the last one left, without starting it', async () => {
  for (const name of ['a.arw', 'b.arw', 'c.arw']) writeFileSync(path.join(root, name), name);
  await build({ processUnprocessed: () => {} }).scanLibrary(LIB);

  // Stands in for the restart: same database, no in-memory status at all.
  let asked = 0;
  const restarted = build({ processUnprocessed: () => void asked++ });
  const status = restarted.getScanStatus(LIB);

  expect(status.status).toBe('idle');
  expect(status.photos_processing).toBe(3);
  expect(asked).toBe(0); // reading the status is not a trigger
});

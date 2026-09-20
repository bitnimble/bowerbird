// ScanService must prune its per-library in-memory status/generation on library
// deletion, else those maps grow unbounded across create/delete cycles.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/analysis/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib000fa';
const flush = () => new Promise((r) => setTimeout(r, 10));

let root: string;
let db: ReturnType<typeof createDatabase>;
let scan: ScanService;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-life-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  const photoProcessingRepo = photoProcessing(db);
  scan = new ScanService(
    photoScan(db, photoProcessingRepo),
    photoPaths(db),
    photoMetadata(db, photoProcessingRepo),
    photoProcessingRepo,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
  );
  copyFileSync(FIXTURE, path.join(root, 'p.arw'));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// The library row is kept so getScanStatus (which checks getById first) can still
// read the map, making the pruning observable.
test('onLibraryDeleted prunes in-memory status (no stale carry-over)', async () => {
  await scan.scanLibrary(LIB);
  await flush();
  expect(scan.getScanStatus(LIB).photos_scanned).toBeGreaterThan(0); // state is present

  scan.onLibraryDeleted(LIB); // lifecycle listener fires on delete

  const status = scan.getScanStatus(LIB);
  expect(status.status).toBe('idle');
  expect(status.photos_scanned).toBe(0); // pruned -> fresh default, not the stale synced status
});

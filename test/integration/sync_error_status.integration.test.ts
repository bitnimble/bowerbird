// A failed scan must not leave the status API reporting 'processing'/'rendition'
// forever, it resets to 'idle' on both the apply-throw and the detached-
// processing-reject paths. Needs a real catalogue:
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import type { PhotoProcessingRepository } from '../../src/services/photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../src/services/photos/scan/photo_scan_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/analysis/metadata';
import { photoMetadata, photoPaths, photoProcessing } from './helpers/photo_repositories';

const LIB = 'lib000ef';
const flush = () => new Promise((r) => setTimeout(r, 10));

let root: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-errst-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function build(
  scanRepository: PhotoScanRepository,
  photoProcessingRepository: PhotoProcessingRepository,
  processing: { processUnprocessed: () => void | Promise<void> },
): ScanService {
  return new ScanService(
    scanRepository,
    photoPaths(db),
    photoMetadata(db, photoProcessingRepository),
    photoProcessingRepository,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    processing,
    extractMetadata,
  );
}

test('an apply-phase throw resets status to idle (not stuck scanning)', async () => {
  const photoProcessingRepo = photoProcessing(db);
  class FailingPhotos extends PhotoScanRepository {
    override immediateTransaction<T>(_fn: () => T): T {
      throw new Error('apply failed');
    }
  }
  const scan = build(new FailingPhotos(db, photoProcessingRepo), photoProcessingRepo, { processUnprocessed() {} });

  await expect(scan.scanLibrary(LIB)).rejects.toThrow('apply failed');
  expect(scan.getScanStatus(LIB).status).toBe('idle');
});

test('a detached-processing rejection resets status to idle (not stuck on renditions)', async () => {
  const photoProcessingRepo = photoProcessing(db);
  const scan = build(new PhotoScanRepository(db, photoProcessingRepo), photoProcessingRepo, {
    processUnprocessed: () => Promise.reject(new Error('proc failed')),
  });

  await scan.scanLibrary(LIB); // succeeds; sets 'rendition', fires detached processing
  await flush(); // let the rejecting tail run
  expect(scan.getScanStatus(LIB).status).toBe('idle');
});

// A failed sync must not leave the status API reporting 'scanning'/'processing'
// forever, it resets to 'idle' on both the apply-throw and the detached-
// processing-reject paths. Needs bun:sqlite:
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/metadata';

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

function build(photos: PhotosRepository, processing: { processUnprocessed: () => void | Promise<void> }): SyncService {
  return new SyncService(
    photos,
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
  class FailingPhotos extends PhotosRepository {
    override immediateTransaction<T>(_fn: () => T): T {
      throw new Error('apply failed');
    }
  }
  const sync = build(new FailingPhotos(db), { processUnprocessed() {} });

  await expect(sync.syncLibrary(LIB)).rejects.toThrow('apply failed');
  expect(sync.getSyncStatus(LIB).status).toBe('idle');
});

test('a detached-processing rejection resets status to idle (not stuck processing)', async () => {
  const sync = build(new PhotosRepository(db), { processUnprocessed: () => Promise.reject(new Error('proc failed')) });

  await sync.syncLibrary(LIB); // succeeds; sets 'processing', fires detached processing
  await flush(); // let the rejecting tail run
  expect(sync.getSyncStatus(LIB).status).toBe('idle');
});

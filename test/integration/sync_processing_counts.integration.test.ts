// DESIGN §9.6: the per-library status reports rendition building progress
// (photos_processing / photos_processed) while the detached processing tail runs.
// The counts are derived live from needs_processing, so they must track the DB.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-0000000000ce';
const flush = () => new Promise((r) => setTimeout(r, 10));

let root: string;
let db: ReturnType<typeof createDatabase>;
let photos: PhotosRepository;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-counts-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'taken_desc');
  photos = new PhotosRepository(db);
  for (const name of ['a.arw', 'b.arw', 'c.arw']) copyFileSync(FIXTURE, path.join(root, name));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('processing counts track rendition progress, then settle when the tail finishes', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  const sync = new SyncService(
    photos,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    { processUnprocessed: () => blocked },
    extractMetadata,
  );

  const status = await sync.syncLibrary(LIB);
  expect(status.photos_added).toBe(3);
  // All three were queued for rendition building by the sync that just inserted them.
  expect(status.photos_processing).toBe(3);
  expect(status.photos_processed).toBe(0);

  // Simulate the worker pool finishing one photo: the live count must follow. Both
  // stages, because a photo still owing either is still pending.
  const [first] = photos.listPendingProcessing(LIB);
  photos.markTileBuilt(first!.photo_id, new Date().toISOString());
  photos.markRenditionsBuilt(first!.photo_id, new Date().toISOString(), 'render');
  expect(sync.getSyncStatus(LIB).photos_processing).toBe(2);
  expect(sync.getSyncStatus(LIB).photos_processed).toBe(1);

  // A failed photo also leaves the queue (both flags cleared), so it counts as done.
  const [second] = photos.listPendingProcessing(LIB);
  photos.markProcessingFailed(second!.photo_id, 'boom');
  expect(sync.getSyncStatus(LIB).photos_processed).toBe(2);

  release();
  await flush();
  const settled = sync.getSyncStatus(LIB);
  expect(settled.status).toBe('idle');
  expect(settled.photos_processing).toBe(1); // the one still pending
  expect(settled.photos_processed).toBe(2);
});

// The sync lock is released before the detached rendition processing runs, so a
// newer sync can start while an older generation's processing tail is still going.
// The older tail's status write must not stomp the newer generation's status.
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
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-0000000000cd';
const flush = () => new Promise((r) => setTimeout(r, 10));

let root: string;
let db: ReturnType<typeof createDatabase>;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-gen-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  copyFileSync(FIXTURE, path.join(root, 'photo.arw'));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test("a stale sync generation's processing tail does not stomp the newer status", async () => {
  let resolveA!: () => void;
  const pA = new Promise<void>((r) => (resolveA = r));
  let calls = 0;
  // Gen A's processing blocks until we resolve it; later generations complete now.
  const processing = { processUnprocessed: () => (calls++ === 0 ? pA : Promise.resolve()) };
  const sync = new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    processing,
    extractMetadata,
  );

  await sync.syncLibrary(LIB); // gen A: indexes photo.arw (added=1), tail blocked on pA
  expect(sync.getSyncStatus(LIB).status).toBe('processing');

  await sync.syncLibrary(LIB); // gen B: nothing changed (added=0); processing resolves now -> idle (B)
  await flush();
  expect(sync.getSyncStatus(LIB).status).toBe('idle');

  resolveA(); // gen A's stale tail completes now
  await flush();
  // Guard must keep B's status; without it, A's tail would re-stamp idle with A's counts.
  expect(sync.getSyncStatus(LIB).status).toBe('idle');
  expect(sync.getSyncStatus(LIB).photos_added).toBe(0); // B's generation (no new indexable photo), not A's added=1
});

// Integration test for filesystem-watch auto-sync. Requires LibRaw -> runs under
// Bun in the container: docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { LibraryWatcher } from '../../src/services/sync/library_watcher';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib00001';
const DEBOUNCE = 150;

let root: string;
let db: ReturnType<typeof createDatabase>;
let watcher: LibraryWatcher;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (rel: string) => path.join(root, rel);
const row = (filePath: string) =>
  db.query('SELECT id, is_missing FROM photos WHERE file_path = ?').get(filePath) as { id: string; is_missing: number } | null;
const count = () => (db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;

// Waits until the DB reaches `expected` (auto-sync is debounced + async).
async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !check(); i++) await sleep(100);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-watch-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  const sync = new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
  );
  watcher = new LibraryWatcher(new LibrariesRepository(db), sync, DEBOUNCE);
  watcher.start();
  await watcher.whenReady(); // chokidar walks the tree before it delivers anything
});

afterAll(() => {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a new file triggers a debounced auto-sync', async () => {
  copyFileSync(FIXTURE, abs('a.arw'));
  await settle(() => count() === 1);
  expect(count()).toBe(1);
});

test('renaming on disk auto-syncs as a move', async () => {
  renameSync(abs('a.arw'), abs('b.arw'));
  await settle(() => row('b.arw') != null);
  expect(row('b.arw')).not.toBeNull();
  expect(row('a.arw')).toBeNull();
  expect(count()).toBe(1);
});

test('deleting on disk auto-syncs to missing', async () => {
  rmSync(abs('b.arw'));
  await settle(() => row('b.arw')?.is_missing === 1);
  expect(row('b.arw')?.is_missing).toBe(1);
});

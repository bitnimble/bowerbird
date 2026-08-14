// Scoped sync (the watcher's cheap path): reconciles the changed paths and
// nothing else, not their directories and not the whole tree. Verifies add, an
// intra-dir rename delivered as both of its halves, delete, a cross-directory
// move reunited with the original row via the missing move-source pool across two
// scoped syncs, and that a file nobody named is left alone.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
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
const LIB = 'lib000c0';

let root: string;
let db: ReturnType<typeof createDatabase>;
let sync: SyncService;

const abs = (rel: string) => path.join(root, rel);
const row = (filePath: string) =>
  db.query('SELECT id, is_missing FROM photos WHERE file_path = ? AND is_deleted = 0').get(filePath) as
    | { id: string; is_missing: number }
    | null;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-scoped-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  mkdirSync(abs('Trip'));
  sync = new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    new SyncLocksRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
  );
  copyFileSync(FIXTURE, abs('c.arw'));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('scoped add indexes the new file', async () => {
  await sync.syncLibrary(LIB, ['c.arw']);
  expect(row('c.arw')).not.toBeNull();
});

test('intra-dir rename, both halves in one window, is a move and not a re-add', async () => {
  const id = row('c.arw')!.id;
  renameSync(abs('c.arw'), abs('d.arw')); // preserves mtime -> same hash
  await sync.syncLibrary(LIB, ['c.arw', 'd.arw']); // both halves, as the watcher names them
  expect(row('c.arw')).toBeNull();
  expect(row('d.arw')?.id).toBe(id); // moved, not re-added as a new photo
});

test('scoped delete flags missing but keeps the record', async () => {
  const id = row('d.arw')!.id;
  // Move it out of root into Trip, but only feed the OLD-name event (root scope):
  // the new file in Trip isn't in scope, so this leg only sees the removal.
  renameSync(abs('d.arw'), abs('Trip/e.arw'));
  await sync.syncLibrary(LIB, ['d.arw']);
  expect(row('d.arw')?.is_missing).toBe(1);
  expect(row('d.arw')?.id).toBe(id); // record retained
});

test('cross-dir move reunites with the missing record via the move-source pool', async () => {
  const id = row('d.arw')!.id; // still the same row, now missing at its old path
  await sync.syncLibrary(LIB, ['Trip/e.arw']); // the target event, in Trip's scope
  expect(row('d.arw')).toBeNull();
  const moved = row('Trip/e.arw');
  expect(moved?.id).toBe(id); // same photo, reunited by hash across two scoped syncs
  expect(moved?.is_missing).toBe(0);
});

// A scoped run answers for what it was handed. A file in the same directory that
// no event named is the full reconcile's business (§9.8), not this run's.
test('a sibling the run was not told about is left alone', async () => {
  copyFileSync(FIXTURE, abs('Trip/unnamed.arw'));
  await sync.syncLibrary(LIB, ['Trip/e.arw']);
  expect(row('Trip/unnamed.arw')).toBeNull();

  await sync.syncLibrary(LIB); // the backstop picks it up
  expect(row('Trip/unnamed.arw')).not.toBeNull();
});

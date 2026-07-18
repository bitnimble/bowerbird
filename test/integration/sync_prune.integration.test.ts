// Dir-mtime pruning (SYNC_PRUNE_UNCHANGED_DIRS): a full scan skips stat-ing files
// in directories whose mtime is unchanged. Verifies structural changes are still
// caught, and documents the tradeoff, an in-place edit in an unchanged directory
// is NOT re-detected (it doesn't bump the dir mtime).
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-0000000000d0';

let root: string;
let db: ReturnType<typeof createDatabase>;
let sync: SyncService;

const abs = (rel: string) => path.join(root, rel);
const row = (filePath: string) => db.query('SELECT id FROM photos WHERE file_path = ?').get(filePath) as { id: string } | null;
const updatedAt = (filePath: string) =>
  (db.query('SELECT date_updated FROM photos WHERE file_path = ?').get(filePath) as { date_updated: string }).date_updated;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-prune-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'taken_desc');
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('a.arw'));
  copyFileSync(FIXTURE, abs('Trip/x.arw'));
  // pruneUnchangedDirs = true
  sync = new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
    true,
  );
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('first pruned full scan indexes everything (empty cache = all dirs changed)', async () => {
  await sync.syncLibrary(LIB);
  expect(row('a.arw')).not.toBeNull();
  expect(row('Trip/x.arw')).not.toBeNull();
});

test('a new file in a directory (bumps its mtime) is detected under pruning', async () => {
  copyFileSync(FIXTURE, abs('b.arw')); // adds an entry to root -> root mtime changes
  await sync.syncLibrary(LIB);
  expect(row('b.arw')).not.toBeNull();
});

test('an in-place edit in an UNCHANGED directory is skipped under pruning (documented caveat)', async () => {
  const before = updatedAt('Trip/x.arw');
  const future = new Date(Date.now() + 60_000);
  utimesSync(abs('Trip/x.arw'), future, future); // file mtime changes; Trip's dir mtime does not
  await sync.syncLibrary(LIB);
  expect(updatedAt('Trip/x.arw')).toBe(before); // pruned: Trip skipped, edit not re-detected
});

// Integration test for the poll fallback, which is what a library on a filesystem
// that reports no file events gets instead of a watch (§9.8). Requires LibRaw ->
// runs under Bun in the container: docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { photoMetadata, photoPaths, photoProcessing, photoScan } from './helpers/photo_repositories';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { LibraryWatcher } from '../../src/services/sync/watch/library_watcher';
import { ScanService } from '../../src/services/sync/scan/scan_service';
import type { ScanScope } from '../../src/services/sync/scan/scan_evidence';
import { SyncLocksRepository } from '../../src/services/sync/coordination/sync_locks_repository';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = 'lib00001';
const DEBOUNCE = 50;
const POLL = 100;

let root: string;
let db: ReturnType<typeof createDatabase>;
let watcher: LibraryWatcher;
// Every scope the poller asked for a scan with, so a run that quietly widened to
// the whole library is visible rather than merely slow.
const scopes: (ScanScope | undefined)[] = [];
let reestablishDuringNextSync = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (rel: string) => path.join(root, rel);
const row = (filePath: string) =>
  db.query(`SELECT id, is_missing FROM photos WHERE json_extract(recipe, '$.path') = ?`).get(filePath) as
    | { id: string; is_missing: number }
    | null;
const count = () => (db.query('SELECT COUNT(*) AS n FROM photos WHERE is_missing = 0').get() as { n: number }).n;

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !check(); i++) await sleep(100);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-poll-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  const photoProcessingRepo = photoProcessing(db);
  const scan = new ScanService(
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
  );
  const scanLibrary = scan.scanLibrary.bind(scan);
  scan.scanLibrary = async (libraryId, scope, trigger) => {
    scopes.push(scope);
    if (reestablishDuringNextSync) {
      reestablishDuringNextSync = false;
      // The pass that asked for this scan is suspended right here, so this is what
      // a settings change landing mid-pass does: the bin name is scope, so the
      // watcher reads it as a library whose watch has to be established afresh.
      db.query('UPDATE libraries SET bin_name = ? WHERE id = ?').run('Bin', LIB);
      watcher.onLibraryUpdated(new LibrariesRepository(db).getById(LIB)!);
    }
    return scanLibrary(libraryId, scope, trigger);
  };
  // The tmpdir is a local filesystem, so the strategy has to be told rather than
  // detected: what is under test is the poller, not what the host is mounted on.
  watcher = new LibraryWatcher(new LibrariesRepository(db), scan, DEBOUNCE, POLL, () => 'nfs4');
  watcher.start();
  await watcher.whenReady(); // the first pass is a baseline, and reports nothing
});

afterAll(() => {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a file copied in is picked up by a later pass', async () => {
  copyFileSync(FIXTURE, abs('a.arw'));
  await settle(() => count() === 1);
  expect(row('a.arw')).not.toBeNull();
});

test('a file in a new subfolder is picked up, folder and contents', async () => {
  mkdirSync(abs('Trip'));
  copyFileSync(FIXTURE, abs('Trip/b.arw'));
  await settle(() => count() === 2);
  expect(row('Trip/b.arw')).not.toBeNull();
});

// The one thing a folder's mtime alone cannot say: what left it. Answered by
// listing the folder against the rows recorded directly in it.
test('a deleted file is flagged missing, and its record kept', async () => {
  const id = row('Trip/b.arw')!.id;
  rmSync(abs('Trip/b.arw'));
  await settle(() => row('Trip/b.arw')?.is_missing === 1);
  expect(row('Trip/b.arw')?.is_missing).toBe(1);
  expect(row('Trip/b.arw')?.id).toBe(id);
});

test('a deleted folder takes its photographs missing with it', async () => {
  copyFileSync(FIXTURE, abs('Trip/c.arw'));
  await settle(() => row('Trip/c.arw')?.is_missing === 0);
  rmSync(abs('Trip'), { recursive: true });
  await settle(() => row('Trip/c.arw')?.is_missing === 1);
  expect(row('Trip/c.arw')?.is_missing).toBe(1);
});

test('every pass reconciled folders rather than falling back to the whole library', async () => {
  expect(scopes.length).toBeGreaterThan(0);
  for (const scope of scopes) {
    expect(scope?.dirs?.length).toBeGreaterThan(0);
    expect(scope?.paths).toEqual([]);
  }
});

test('a library nothing happens in is not synced at all', async () => {
  const before = scopes.length;
  await sleep(POLL * 5);
  expect(scopes.length).toBe(before);
});

// A settings change re-establishes the loop synchronously, while the pass it
// replaced is suspended inside its own scan. The pass that resumes into a library
// somebody else is now polling must not re-arm itself: it holds a timer nothing
// can reach to cancel, so the share is walked at twice the rate it was asked for
// and the two loops overwrite each other's baseline. Counted as passes rather than
// as syncs because they share one baseline, so the doubling is what shows.
test('a settings change during a pass leaves one poll loop, not two', async () => {
  copyFileSync(FIXTURE, abs('d.arw'));
  await settle(() => row('d.arw')?.is_missing === 0);

  reestablishDuringNextSync = true;
  rmSync(abs('d.arw'));
  await settle(() => row('d.arw')?.is_missing === 1);

  let passes = 0;
  const folderMtimes = watcher['folderMtimes'].bind(watcher);
  watcher['folderMtimes'] = (scope) => {
    passes++;
    return folderMtimes(scope);
  };
  const window = POLL * 8;
  await sleep(window);
  expect(passes).toBeLessThanOrEqual(window / POLL + 1);
});

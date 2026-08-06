// The sync lease's one unique contribution is cross-process exclusion (§8), and
// it is invisible to a same-process test: `fcntl` locks are per-inode, so two
// Database handles in one process contend with nobody. Two real processes over
// one database file, told to sync one library at once.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { SyncService } from '../../src/services/sync/sync_service';
import { SyncLocksRepository } from '../../src/services/sync/sync_locks_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const RUNNER = path.join(import.meta.dir, 'helpers/sync_once.ts');
const LIB = '00000000-0000-4000-8000-0000000000b8';
const COPIES = 6; // enough scan work that the loser is still inside the winner's run

let dir: string;
let root: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bb-lease-'));
  root = path.join(dir, 'photos');
  dbPath = path.join(dir, 'bowerbird.db');
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < COPIES; i++) copyFileSync(FIXTURE, path.join(root, `p${i}.arw`));

  const db = createDatabase(dbPath);
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  db.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function syncInOwnProcess(startAt: number): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', RUNNER, dbPath, LIB, String(startAt)], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().split('\n').at(-1) ?? '';
}

test(
  'two processes syncing one library: one wins, the other is told a sync is running',
  async () => {
    const startAt = Date.now() + 1_500; // both spawned and waiting before either acquires
    const [a, b] = await Promise.all([syncInOwnProcess(startAt), syncInOwnProcess(startAt)]);

    expect([a, b].filter((r) => r === 'ok')).toHaveLength(1);
    expect([a, b].filter((r) => r === 'SYNC_IN_PROGRESS')).toHaveLength(1);

    // The point of the exclusion: the loser must not have imported the same tree
    // a second time.
    const db = createDatabase(dbPath);
    const { count } = db.query('SELECT COUNT(*) AS count FROM photos').get() as { count: number };
    db.close();
    expect(count).toBe(COPIES);
  },
  30_000,
);

// Reclaim is by expiry, so a container killed and restarted within seconds finds
// its own dead run still holding the lease. Swallowing that would drop the
// library until tomorrow.
test('syncAll re-attempts a library it found locked', async () => {
  const db = createDatabase(dbPath);
  let refusals = 1;
  const locks = new (class extends SyncLocksRepository {
    override acquire(libraryId: string, owner: string): boolean {
      if (refusals-- > 0) return false;
      return super.acquire(libraryId, owner);
    }
  })(db);
  const sync = new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    locks,
    { processUnprocessed() {} },
    extractMetadata,
  );

  await sync.syncAll();
  const { count } = db.query('SELECT COUNT(*) AS count FROM photos').get() as { count: number };
  expect(count).toBe(COPIES);
  db.close();
}, 30_000);

test('a sync whose lease was taken over rolls its apply back', async () => {
  const db = createDatabase(dbPath);
  const locks = new SyncLocksRepository(db);
  const photos = new PhotosRepository(db);
  const sync = new SyncService(
    photos,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    // Every acquire reports success, so the run believes it holds a lease that
    // somebody else's owner is written into - which is the crash the apply's
    // owner re-read exists to catch.
    new (class extends SyncLocksRepository {
      override acquire(): boolean {
        return true;
      }
      override ownerOf(): string | null {
        return 'somebody-else';
      }
    })(db),
    { processUnprocessed() {} },
    extractMetadata,
  );

  await expect(sync.syncLibrary(LIB)).rejects.toThrow(/lease/);
  const { count } = db.query('SELECT COUNT(*) AS count FROM photos').get() as { count: number };
  expect(count).toBe(0);
  expect(locks.ownerOf(LIB)).toBeNull();
  db.close();
});

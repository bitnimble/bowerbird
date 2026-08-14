// The sync lease's one unique contribution is cross-process exclusion (§9.7), and
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
const LIB = 'lib000b8';
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

async function run(role: 'hold' | 'sync'): Promise<string[]> {
  const proc = Bun.spawn(['bun', 'run', RUNNER, role, dbPath, LIB, path.join(dir, 'signals')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (err.trim() !== '') console.error(`${role} stderr: ${err}`);
  return out.trim().split('\n');
}

test(
  'a lease held by another process refuses the sync, and lets it through once released',
  async () => {
    const [holder, syncer] = await Promise.all([run('hold'), run('sync')]);

    expect(holder).toEqual(['held']);
    // Nothing else can have refused it: `libraryMutex` is process-global, so the
    // two processes cannot see each other's.
    expect(syncer).toEqual(['while held: SYNC_IN_PROGRESS', 'once free: ok']);

    // And the refused run imported nothing, so the tree is in the catalogue once.
    const db = createDatabase(dbPath);
    const { count } = db.query('SELECT COUNT(*) AS count FROM photos').get() as { count: number };
    db.close();
    expect(count).toBe(COPIES);
  },
  60_000,
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
    // A real acquire and a real release - only the owner read is faked, so the
    // run takes the lease it thinks it has and the row it wrote is the one the
    // assertions below look at. The apply then reads somebody else's owner back,
    // which is the takeover its re-read exists to catch.
    new (class extends SyncLocksRepository {
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

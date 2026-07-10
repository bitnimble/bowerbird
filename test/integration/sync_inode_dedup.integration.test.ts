// A non-atomic move (link()+unlink()) briefly exposes the same inode under two
// paths. Sync must collapse the hardlink pair to one path (preferring the DB
// record) instead of inserting the second as a duplicate photo. Needs LibRaw:
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
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
const LIB = '00000000-0000-4000-8000-0000000000ab';

let root: string;
let db: ReturnType<typeof createDatabase>;
let sync: SyncService;

const rows = () => db.query('SELECT file_path, is_missing FROM photos').all() as { file_path: string; is_missing: number }[];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-inode-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, ordering) VALUES (?, ?, ?)').run(LIB, root, 'taken_desc');
  sync = new SyncService(
    new PhotosRepository(db),
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    { processUnprocessed() {} },
    extractMetadata,
  );
  copyFileSync(FIXTURE, path.join(root, 'photo.arw'));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a hardlink pair (in-flight move artifact) does not create a duplicate row', async () => {
  await sync.syncLibrary(LIB);
  expect(rows()).toHaveLength(1);

  // Both names now point at one inode, as during moveIntoDir's link->unlink window.
  linkSync(path.join(root, 'photo.arw'), path.join(root, 'photo_copy.arw'));
  await sync.syncLibrary(LIB);

  const after = rows();
  expect(after).toHaveLength(1); // no duplicate for photo_copy.arw
  expect(after[0]!.file_path).toBe('photo.arw'); // kept the DB-matching path
  expect(after[0]!.is_missing).toBe(0);
});

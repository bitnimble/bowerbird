// A library deleted while its sync is mid-scan must abort cleanly (NOT_FOUND),
// not crash with a foreign-key violation when the apply transaction inserts
// against the now-cascade-deleted library_id. Needs bun:sqlite + LibRaw:
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../src/db/connection';
import { AppError } from '../../src/errors';
import { AlbumsRepository } from '../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../src/services/shoots/shoots_repository';
import { SyncService } from '../../src/services/sync/sync_service';
import { extractMetadata } from '../../src/services/processing/metadata';

const FIXTURE = path.join(import.meta.dir, '../fixtures/DSC02981.ARW');
const LIB = '00000000-0000-4000-8000-0000000000de';

let root: string;
let db: ReturnType<typeof createDatabase>;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-delrace-'));
  db = createDatabase(':memory:');
  db.query('INSERT INTO libraries (id, root_path, name, ordering) VALUES (?, ?, ?, ?)').run(LIB, root, 'lib', 'taken_desc');
  copyFileSync(FIXTURE, path.join(root, 'photo.arw'));
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('a library deleted during scan aborts with NOT_FOUND, no FK crash, no orphan rows', async () => {
  const photos = new PhotosRepository(db);
  // Simulate a concurrent DELETE /libraries/:id landing during the async scan.
  const extractThenDelete = async (p: string) => {
    const meta = await extractMetadata(p);
    db.query('DELETE FROM libraries WHERE id = ?').run(LIB);
    return meta;
  };
  const sync = new SyncService(
    photos,
    new LibrariesRepository(db),
    new AlbumsRepository(db),
    new ShootsRepository(db),
    new FolderRulesRepository(db),
    { processUnprocessed() {} },
    extractThenDelete,
  );

  const err = await sync.syncLibrary(LIB).then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe('NOT_FOUND');
  const n = (db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number }).n;
  expect(n).toBe(0); // no row inserted against the dead library_id
});

// Two roles for the two-process lease test (§8), because a same-process test
// cannot stage what it is about: `libraryMutex` is process-global, so in one
// process it is the mutex and not the lease that would be doing the excluding.
//
//   hold  - takes the lease directly, announces it, holds it, releases it
//   sync  - waits for that announcement, then syncs twice: once while the lease
//           is held, once after it is gone
//
// Prints one line per attempt, nothing else.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../../../src/db/connection';
import { AlbumsRepository } from '../../../src/services/albums/albums_repository';
import { LibrariesRepository } from '../../../src/services/libraries/libraries_repository';
import { PhotosRepository } from '../../../src/services/photos/photos_repository';
import { FolderRulesRepository } from '../../../src/services/shoots/folder_rules_repository';
import { ShootsRepository } from '../../../src/services/shoots/shoots_repository';
import { SyncLocksRepository } from '../../../src/services/sync/sync_locks_repository';
import { SyncService } from '../../../src/services/sync/sync_service';
import { extractMetadata } from '../../../src/services/processing/metadata';
import { AppError } from '../../../src/errors';

const [role, dbPath, libraryId, signals] = process.argv.slice(2) as ['hold' | 'sync', string, string, string];
const held = path.join(signals, 'held');
const released = path.join(signals, 'released');

const db = createDatabase(dbPath);
const locks = new SyncLocksRepository(db);

const outcome = async (attempt: () => Promise<unknown>): Promise<string> => {
  try {
    await attempt();
    return 'ok';
  } catch (err) {
    return err instanceof AppError ? err.code : `unexpected: ${String(err)}`;
  }
};

if (role === 'hold') {
  mkdirSync(signals, { recursive: true });
  console.log(locks.acquire(libraryId, 'holder') ? 'held' : 'could not take the lease');
  writeFileSync(held, '');
  // Long enough for the other process to have started, synced and reported.
  await Bun.sleep(3_000);
  locks.release(libraryId, 'holder');
  writeFileSync(released, '');
} else {
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
  for (let i = 0; i < 600 && !existsSync(held); i++) await Bun.sleep(20);
  console.log(`while held: ${await outcome(() => sync.syncLibrary(libraryId))}`);
  for (let i = 0; i < 600 && !existsSync(released); i++) await Bun.sleep(20);
  console.log(`once free: ${await outcome(() => sync.syncLibrary(libraryId))}`);
}

db.close();

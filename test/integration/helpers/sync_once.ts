// One process, one sync, so the two-process lease test has something to race
// against itself: `fcntl` locks are per-inode and invisible to two Database
// handles in one process, so the contention §8 is about cannot be staged
// in-process. Prints `ok` or the AppError code, nothing else.
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

const [dbPath, libraryId, startAt] = process.argv.slice(2) as [string, string, string];

// Both processes enter at the same wall-clock instant, so the two acquires land
// within milliseconds of each other rather than one whole sync apart.
const waitUntil = Number(startAt) - Date.now();
if (waitUntil > 0) await Bun.sleep(waitUntil);

const db = createDatabase(dbPath);
const sync = new SyncService(
  new PhotosRepository(db),
  new LibrariesRepository(db),
  new AlbumsRepository(db),
  new ShootsRepository(db),
  new FolderRulesRepository(db),
  new SyncLocksRepository(db),
  { processUnprocessed() {} },
  extractMetadata,
);

try {
  await sync.syncLibrary(libraryId);
  console.log('ok');
} catch (err) {
  console.log(err instanceof AppError ? err.code : `unexpected: ${String(err)}`);
} finally {
  db.close();
}

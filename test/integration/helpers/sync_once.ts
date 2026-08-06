// One process, one sync, so the two-process lease test has something to race
// against itself: `fcntl` locks are per-inode and invisible to two Database
// handles in one process, so the contention §8 is about cannot be staged
// in-process. Prints `ok` or the AppError code, nothing else.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

const [dbPath, libraryId, barrier, id] = process.argv.slice(2) as [string, string, string, string];

// A barrier rather than a wall-clock instant: `bun run` plus this module's own
// native loading is seconds on a cold cache, which is long enough for one process
// to finish a whole sync before the other has started.
mkdirSync(barrier, { recursive: true });
writeFileSync(path.join(barrier, id), '');
for (let i = 0; i < 600 && readdirSync(barrier).length < 2; i++) await Bun.sleep(50);

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

// Repeated for a fixed window rather than a fixed count: a sync of a small
// fixture holds the lease for a few milliseconds, so two processes released from
// a barrier can run a whole count of them past each other. A window both are
// certainly inside makes the collision structural rather than lucky.
const until = Date.now() + 3_000;
let ok = 0;
let busy = 0;
let unexpected = '';
while (Date.now() < until) {
  try {
    await sync.syncLibrary(libraryId);
    ok++;
  } catch (err) {
    if (err instanceof AppError && err.code === 'SYNC_IN_PROGRESS') busy++;
    else unexpected ||= String(err);
  }
}
db.close();
console.log(unexpected === '' ? `ok=${ok} busy=${busy}` : `unexpected: ${unexpected}`);

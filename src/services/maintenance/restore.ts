// Putting a snapshot back (§4.9). Offline, from `scripts/restore-backup.ts`,
// because the running server holds the file this replaces.
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { LATEST_USER_VERSION } from '../../db/migrations';
import { deleteRestoreStaging } from '../../utils/deletions';

// SQLite derives these names from the database's filename, so one belonging to the
// catalogue being replaced is replayed over the restored file on the next start.
// They move with the database they belong to. `-journal` is here for completeness
// rather than because this app writes one: it is what a rollback-mode SQLite leaves,
// and a stale one beside the restored file would be replayed the same way.
const SIDECARS = ['-wal', '-shm', '-journal'];

export interface RestoreResult {
  /** Where the previous catalogue was parked, or null if there was none to park. */
  movedAside: string | null;
  version: number;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A file that is not a database at all throws here rather than failing
// `quick_check`, so it has to be caught to come out as the same refusal.
function openBackup(backupPath: string): Database {
  try {
    return new Database(backupPath, { readonly: true });
  } catch (err) {
    throw new Error(`${backupPath} is not intact: ${reason(err)}`);
  }
}

// Restoring an older backup is fine: the migrations run on the next start and
// bring it forward. The other direction cannot work - this build's migrations have
// no route to a schema they predate - and it would surface as a corrupt-looking
// catalogue rather than an error, so it is refused.
//
// The check is weaker than it looks and is a backstop rather than a guarantee:
// only one migration stamps `user_version` at all, the rest recognising their own
// work from the schema, so a future build that adds no stamped migration produces
// backups this cannot tell from its own (§4.9).
function checkVersion(db: Database, backupPath: string): number {
  let check: string;
  let version: number;
  try {
    ({ quick_check: check } = db.query('PRAGMA quick_check').get() as { quick_check: string });
    ({ user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number });
  } catch (err) {
    throw new Error(`${backupPath} is not intact: ${reason(err)}`);
  }
  if (check !== 'ok') throw new Error(`${backupPath} is not intact: quick_check says ${check}`);
  if (version > LATEST_USER_VERSION) {
    throw new Error(
      `${backupPath} was written by a newer Bowerbird (schema ${version}, this build understands ${LATEST_USER_VERSION}). Upgrade before restoring it.`,
    );
  }
  return version;
}

// A restore while the server is up looks like it worked and throws away everything
// written afterwards: the server keeps writing through its open handle to the inode
// this moves aside, so its reads stay right, its shutdown is clean, and the work is
// discarded at the next start. `restart: unless-stopped` in the compose file means
// "stop the server first" cannot be left to a comment.
//
// Exclusive locking rather than a pidfile, because it asks the question that
// matters - can anyone else be writing to this catalogue - of the database itself,
// and gets it right for a server in another container sharing the volume.
//
// **Only a lock counts.** Every other way this can fail - not a database, a trashed
// header, a read-only file or directory - says the catalogue is broken or
// unwritable, which is precisely why somebody is restoring. Refusing on those
// leaves them no way through at all, told to stop a server that is not running,
// with the only remaining move being to delete their catalogue by hand.
function refuseIfInUse(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  let probe: Database;
  try {
    probe = new Database(dbPath);
  } catch {
    return; // nothing can be serving from a file that will not open
  }
  try {
    probe.exec('PRAGMA busy_timeout = 0;');
    // Exclusive locking mode rather than the write lock alone: an *idle* server
    // holds no write lock, and it is still a server.
    probe.exec('PRAGMA locking_mode = EXCLUSIVE;');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('COMMIT');
  } catch (err) {
    if ((err as { code?: string }).code !== 'SQLITE_BUSY') return;
    throw new Error(`${dbPath} is open in another process. Stop Bowerbird first, or the work it is holding will be lost.`);
  } finally {
    probe.close();
  }
}

// A symlinked DB_PATH is a deliberate placement - the catalogue lives on another
// volume - and writing the restored file at the link's own path silently relocates
// it, orphaning the real one where nothing will ever look again.
//
// `lstat` rather than `existsSync`, which follows the link: a link whose target is
// missing is exactly when this matters, because a volume that failed to mount is
// one of the two ways people arrive here. Reading it as "no catalogue" would put
// the restored file on top of the link and leave the real one unreachable.
function resolveCatalogue(dbPath: string): string {
  const link = lstatSync(dbPath, { throwIfNoEntry: false });
  if (link?.isSymbolicLink() === true) {
    return path.resolve(path.dirname(dbPath), readlinkSync(dbPath));
  }
  return path.resolve(dbPath);
}

export async function restoreBackup(rawDbPath: string, backupPath: string): Promise<RestoreResult> {
  if (!existsSync(backupPath)) throw new Error(`no such backup: ${backupPath}`);
  const dbPath = resolveCatalogue(rawDbPath);
  if (path.resolve(backupPath) === dbPath) throw new Error('the backup and the catalogue are the same file');

  const staged = `${dbPath}.restoring-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const source = openBackup(backupPath);
  let version: number;
  try {
    // Before the in-use probe, which opens the catalogue read-write and so may
    // checkpoint a stale `-wal` into it. Harmless in itself, but a restore that is
    // then refused for a bad backup must not have touched the live catalogue at all.
    version = checkVersion(source, backupPath);
    refuseIfInUse(dbPath);
    // `VACUUM INTO` rather than a file copy, for the same reason the backup uses it:
    // a copy takes the main file alone, and a catalogue's committed work can be
    // almost entirely in its `-wal`. Copying one of those restores an empty
    // database that passes every check - measured, a 4KB main file beside a 1.8MB
    // WAL holding all 300 rows, and the copy had not even the table. That is not a
    // hypothetical here: the two sources this is pointed at are a catalogue parked
    // by an earlier restore, which keeps its `-wal` by design, and a copy rescued
    // from elsewhere, which normally arrives with one.
    source.run('VACUUM INTO ?', [staged]);
  } catch (err) {
    source.close();
    await deleteRestoreStaging(dbPath, staged).catch(() => {});
    throw err;
  }
  source.close();

  const aside = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  // The empty suffix is the catalogue itself, moved first. The sidecars move whether
  // or not it is still there, which is the case that actually happens: someone whose
  // catalogue looks broken deletes it and restores, and a `-wal` left behind then
  // replays the broken catalogue straight back over the restore, with nothing about
  // the result looking wrong.
  const moved: string[] = [];
  try {
    for (const suffix of ['', ...SIDECARS]) {
      if (!existsSync(`${dbPath}${suffix}`)) continue;
      await rename(`${dbPath}${suffix}`, `${aside}${suffix}`);
      moved.push(suffix);
    }
    await rename(staged, dbPath);
  } catch (err) {
    // Failing here would otherwise leave no catalogue at all: the real one renamed
    // to a name nothing has been told about, and a server that creates a fresh empty
    // one at the next start. Put back what was moved before giving up.
    for (const suffix of moved.reverse()) {
      await rename(`${aside}${suffix}`, `${dbPath}${suffix}`).catch(() => {});
    }
    await deleteRestoreStaging(dbPath, staged).catch(() => {});
    throw new Error(`the restore was undone: ${reason(err)}`);
  }

  // Only when the catalogue itself was parked. A lone `-wal` moved out of the way is
  // not something to point anyone at as "the catalogue that was there".
  return { movedAside: moved.includes('') ? aside : null, version };
}

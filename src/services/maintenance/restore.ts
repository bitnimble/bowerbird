// Putting a snapshot back (§4.9). Offline, from `scripts/restore-backup.ts`,
// because the running server holds the file this replaces.
import { Database } from '../../db/driver';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { isMissingCatalogue, isWalMode } from '../../db/connection';
import { appliedMigrationMillis, latestMigrationMillis, runMigrations } from '../../db/migrate';
import { newestStamp, restampRestored } from '../replication/restamp';
import { deleteRestoreStaging } from '../../utils/deletions';
import { resolveCatalogue } from '../../utils/paths';

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
  /** Rows re-stamped so a replicated library keeps what was restored (§8.2). */
  restamped: number;
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

// Restoring an older backup is fine: `prepareStaged` migrates it forward inside the
// restore, before the swap. The other direction cannot work - this build's migrations
// have no route to a schema they predate - and it would surface as a corrupt-looking
// catalogue rather than an error, so it is refused.
//
// Every schema change is a migration and every migration carries the moment it was generated, so a
// backup naming one this build does not ship was written by a later one.
function checkVersion(db: Database, backupPath: string): number {
  let check: string;
  let version: number;
  try {
    ({ quick_check: check } = db.query('PRAGMA quick_check').get() as { quick_check: string });
    version = appliedMigrationMillis(db);
  } catch (err) {
    throw new Error(`${backupPath} is not intact: ${reason(err)}`);
  }
  if (check !== 'ok') throw new Error(`${backupPath} is not intact: quick_check says ${check}`);
  const understood = latestMigrationMillis();
  if (version > understood) {
    throw new Error(
      `${backupPath} was written by a newer Bowerbird (schema ${version}, this build understands ${understood}). Upgrade before restoring it.`,
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
// **The lock is held, not sampled.** Everything after this - vacuuming the snapshot
// out, four renames - takes as long as the catalogue is big, measured at 3.7s for
// 244MB and minutes on a slow volume. Releasing the lock on the way out leaves that
// entire window open for a server to start in, and one that does writes through its
// handle to the inode about to be moved aside: its reads stay right, its shutdown is
// clean, and the work is discarded at the next start with nothing reported anywhere.
// `restart: unless-stopped` makes that window a likely place for a server to appear,
// not a theoretical one. The returned connection is closed by the caller, once the
// swap is done.
export function holdAgainstUse(dbPath: string): Database | null {
  // A missing catalogue is not a reason to skip the lock - it is the *likeliest*
  // reason to be here, since one of the two arrival routes is somebody deleting the
  // catalogue that looked broken. With nothing at the path there is nothing to lock,
  // so a server starting during the vacuum creates its own catalogue there, takes
  // writes into it, and has them discarded by the final rename. Measured: 60
  // committed rows gone, both processes exiting 0, nothing logged. So an empty file
  // is put there purely to be locked.
  //
  // An empty database counts as nothing there, on the same reading the server uses
  // to decide whether it is being asked to replace a catalogue: that is what an
  // earlier killed restore's own placeholder is.
  const placeholder = isMissingCatalogue(dbPath);
  let probe: Database;
  try {
    // Options only when creating: `{ create: false }` is not "open the existing
    // one", it drops the connection to read-only, which cannot take a write lock
    // and so reports every catalogue as free.
    probe = placeholder ? new Database(dbPath, { create: true }) : new Database(dbPath);
  } catch {
    return null; // nothing can be serving from a file that will not open
  }
  try {
    probe.exec('PRAGMA busy_timeout = 0;');
    // Exclusive locking mode rather than the write lock alone: an *idle* server
    // holds no write lock, and it is still a server. It also keeps the lock until
    // this connection closes, which is what makes holding it possible at all.
    probe.exec('PRAGMA locking_mode = EXCLUSIVE;');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('COMMIT');
    return probe;
  } catch (err) {
    probe.close();
    // `startsWith`, because bun reports SQLite's *extended* result codes. A lock
    // refusal can arrive as `SQLITE_BUSY_RECOVERY` - another process recovering this
    // WAL after a crash, which with `restart: unless-stopped` is the exact shape of
    // "the server died and came back while I was restoring" - or as
    // `SQLITE_BUSY_SNAPSHOT`. Matching the primary code alone lets those through as
    // "not a lock", and a restore under a live server loses everything since.
    if ((err as { code?: string }).code?.startsWith('SQLITE_BUSY') !== true) return null;
    // A refusal is not proof on its own, so the file is asked as well. libSQL never finalizes a
    // prepared statement (libsql-js#228), so any connection this process has opened read-write goes
    // on holding the catalogue after `close()` - and refuses this probe exactly as a running server
    // would. The header tells the two apart: a server puts a catalogue into WAL mode as it opens it
    // and `Database.close` takes it back out, so rollback mode means the lock is one of ours and
    // there is nothing to stop. The upstream issue names this the workaround; the probe above is
    // already the exec-only half of it, being the one kind of connection that does release.
    if (!isWalMode(dbPath)) return null;
    throw new Error(`${dbPath} is open in another process. Stop Bowerbird first, or the work it is holding will be lost.`);
  }
}

// A restore killed between its vacuum and its rename leaves a catalogue-sized file
// beside the catalogue that nothing else names - the same litter the backup side
// sweeps, and there is no reason for this side to be the one that hoards it.
//
// Only files old enough that no live run could still be writing them, for the same
// reason the backup side waits: a second restore started by an impatient user would
// otherwise delete the first's staging file mid-vacuum, and that run then dies at
// its rename. Nothing is lost either way - the parks roll back - but a restore that
// fails because somebody ran it twice is a bad thing to hand someone mid-disaster.
const ABANDONED_STAGING_AFTER_MS = 60 * 60 * 1000;

async function sweepAbandonedStaging(dbPath: string): Promise<void> {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.restoring-`;
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith(prefix))) {
    const file = path.join(dir, name);
    const age = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < ABANDONED_STAGING_AFTER_MS) continue;
    await deleteRestoreStaging(dbPath, file).catch(() => {});
  }
}

function catalogueClock(held: Database): string | null {
  try {
    return newestStamp(held);
  } catch {
    return null;
  }
}

/**
 * Makes the staged file the thing the peers will take, before it is anything.
 *
 * Migrated forward and re-stamped *here*, while it is still a file beside the
 * catalogue that nothing is using - so a backup older than this build, a clock the
 * mint guard refuses, and a disk with nothing left are all ordinary failures of a
 * restore that has changed not one byte. Run after the swap instead, each of them is
 * a failure reported over a catalogue that is in fact restored, and a window in which
 * the restored rows sit at stamps the peers have already passed. Surviving that window
 * takes a marker file beside the catalogue, a walk deferred to the next start, and every
 * session refused while one is pending - all of which this ordering makes unnecessary.
 *
 * The floor is the live catalogue's own clock, read through the handle the lock
 * already holds: stamps from the week being rolled back are out on other peers, and
 * a clock that only knew what the backup knew would mint below them and lose.
 *
 * Not WAL. `runMigrations` writing through one leaves a `-wal` beside the staged
 * file, and the rename below moves the main file alone - which would drop every
 * migration it had just made, silently.
 */
function prepareStaged(staged: string, held: Database | null, version: number): number {
  // No log is no floor, not a failure: the catalogue being replaced may predate
  // replication, or be the empty file the lock put there when there was nothing to
  // lock at all - which is one of the two ways anybody arrives here.
  const floor = held == null ? null : catalogueClock(held);
  const db = new Database(staged);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    // The same forward the server would do at its next start, done now so that a
    // backup this build cannot migrate fails the restore rather than producing a
    // catalogue it will not open.
    if (version !== latestMigrationMillis()) runMigrations(db);
    return restampRestored(db, floor);
  } finally {
    db.close();
  }
}

export async function restoreBackup(rawDbPath: string, backupPath: string): Promise<RestoreResult> {
  if (!existsSync(backupPath)) throw new Error(`no such backup: ${backupPath}`);
  const dbPath = resolveCatalogue(rawDbPath);
  if (path.resolve(backupPath) === dbPath) throw new Error('the backup and the catalogue are the same file');
  await sweepAbandonedStaging(dbPath);

  const staged = `${dbPath}.restoring-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const source = openBackup(backupPath);
  let version: number;
  let restamped: number;
  let held: Database | null = null;
  // Read before the lock is taken, because taking it creates the empty file when
  // there is none - so asking afterwards, or asking the lock, gets the answer wrong
  // on exactly the path where the lock could not be acquired.
  const hadNoCatalogue = isMissingCatalogue(dbPath);
  try {
    // Before taking the lock, which opens the catalogue read-write and so may
    // checkpoint a stale `-wal` into it. Harmless in itself, but a restore that is
    // then refused for a bad backup must not have touched the live catalogue at all.
    version = checkVersion(source, backupPath);
    held = holdAgainstUse(dbPath);
    // `VACUUM INTO` rather than a file copy, for the same reason the backup uses it:
    // a copy takes the main file alone, and a catalogue's committed work can be
    // almost entirely in its `-wal`. Copying one of those restores an empty
    // database that passes every check - measured, a 4KB main file beside a 1.8MB
    // WAL holding all 300 rows, and the copy had not even the table. That is not a
    // hypothetical here: the two sources this is pointed at are a catalogue parked
    // by an earlier restore, which keeps its `-wal` by design, and a copy rescued
    // from elsewhere, which normally arrives with one.
    source.run('VACUUM INTO ?', [staged]);
    // While it is still only a file beside the catalogue, so every way this can
    // fail is a restore that has changed nothing and can simply be run again.
    restamped = prepareStaged(staged, held, version);
  } catch (err) {
    source.close();
    held?.close();
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
  // The empty file put there to be locked is this function's own, not a catalogue:
  // parking it would leave an empty "the catalogue that was there" for somebody to
  // be pointed at. The final rename replaces it in place.
  const parkable = hadNoCatalogue ? SIDECARS : ['', ...SIDECARS];
  const moved: string[] = [];
  try {
    for (const suffix of parkable) {
      if (!existsSync(`${dbPath}${suffix}`)) continue;
      await rename(`${dbPath}${suffix}`, `${aside}${suffix}`);
      moved.push(suffix);
    }
    await rename(staged, dbPath);
  } catch (err) {
    // Failing here would otherwise leave no catalogue at all: the real one renamed
    // to a name nothing has been told about, and a server that creates a fresh empty
    // one at the next start. Put back what was moved before giving up.
    const stranded: string[] = [];
    for (const suffix of moved.reverse()) {
      await rename(`${aside}${suffix}`, `${dbPath}${suffix}`).catch(() => stranded.push(`${aside}${suffix}`));
    }
    await deleteRestoreStaging(dbPath, staged).catch(() => {});
    held?.close();
    // Saying "undone" when it could not be undone is the one thing worse than the
    // failure: the files would be sitting at a path nobody has been shown, and the
    // next start would make a fresh empty catalogue on top of the gap.
    if (stranded.length > 0) {
      throw new Error(
        `the restore failed and could not be undone: ${reason(err)}. Your files are at ${stranded.join(', ')} - move them back by hand.`,
      );
    }
    throw new Error(`the restore was undone: ${reason(err)}`);
  }
  // Only when the catalogue itself was parked. A lone `-wal` moved out of the way is
  // not something to point anyone at as "the catalogue that was there".
  const parked = moved.includes('') ? aside : null;

  // Nothing between the rename and here can fail, which is the point of the
  // ordering: the file in place is already migrated and already re-stamped, so
  // there is no window in which a peer dialling in would be handed the restored
  // state at stamps it has passed.
  held?.close();

  return { movedAside: parked, version, restamped };
}

// Putting a snapshot back (§4.9). Offline, from `scripts/restore-backup.ts`,
// because the running server holds the file this replaces.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { LATEST_USER_VERSION } from '../../db/migrations';

// SQLite derives these names from the database's filename, so a `-wal` belonging
// to the catalogue being replaced is replayed over the restored file on the next
// start. They move with the database they belong to.
const SIDECARS = ['-wal', '-shm'];

export interface RestoreResult {
  /** Where the previous catalogue and its sidecars were parked, or null if there were none. */
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
function readVersion(backupPath: string): number {
  const db = openBackup(backupPath);
  let check: string;
  let version: number;
  try {
    ({ quick_check: check } = db.query('PRAGMA quick_check').get() as { quick_check: string });
    ({ user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number });
  } catch (err) {
    throw new Error(`${backupPath} is not intact: ${reason(err)}`);
  } finally {
    db.close();
  }
  if (check !== 'ok') throw new Error(`${backupPath} is not intact: quick_check says ${check}`);
  if (version > LATEST_USER_VERSION) {
    throw new Error(
      `${backupPath} was written by a newer Bowerbird (schema ${version}, this build understands ${LATEST_USER_VERSION}). Upgrade before restoring it.`,
    );
  }
  return version;
}

export async function restoreBackup(dbPath: string, backupPath: string): Promise<RestoreResult> {
  if (!existsSync(backupPath)) throw new Error(`no such backup: ${backupPath}`);
  if (path.resolve(backupPath) === path.resolve(dbPath)) throw new Error('the backup and the catalogue are the same file');
  // Both refusals land before anything on disk moves.
  const version = readVersion(backupPath);

  // Staged beside the catalogue and renamed in, rather than copied over it: a copy
  // is not atomic, so a full disk partway through would leave a truncated file
  // where the catalogue used to be, after the real one had already been moved away.
  const staged = `${dbPath}.restoring`;
  await copyFile(backupPath, staged);

  const aside = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let movedAside: string | null = null;
  // The empty suffix is the catalogue itself, moved first. The sidecars move
  // whether or not it is still there, which is the case that actually happens:
  // someone whose catalogue looks broken deletes it and restores, and a `-wal` left
  // behind then replays the broken catalogue straight back over the restore, with
  // nothing about the result looking wrong.
  for (const suffix of ['', ...SIDECARS]) {
    if (!existsSync(`${dbPath}${suffix}`)) continue;
    await rename(`${dbPath}${suffix}`, `${aside}${suffix}`);
    movedAside = aside;
  }

  await rename(staged, dbPath);
  return { movedAside, version };
}

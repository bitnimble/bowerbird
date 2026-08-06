import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { LATEST_USER_VERSION } from '../../db/migrations';

// Putting a snapshot back (§4.9). Offline, from `scripts/restore-backup.ts`,
// because the running server holds the file this replaces.
//
// The sidecars are half of what makes this correct: SQLite derives these names
// from the database's filename, so leaving the live ones in place would replay
// the *old* catalogue's uncheckpointed pages over the restored file. They travel
// with the database they belong to instead, which is also what keeps the
// displaced catalogue openable if the restore turns out to be the wrong call.
const SIDECARS = ['-wal', '-shm'];

export interface RestoreResult {
  /** Where the catalogue that was there has been moved, or null if there was none. */
  movedAside: string | null;
  version: number;
}

// Restoring an older backup is fine: the migrations run on the next start and
// bring it forward. The other direction cannot work - a newer Bowerbird's schema
// is not something this build's migrations know how to arrive at - and the
// failure would be a corrupt-looking catalogue rather than an error, so it is
// refused here.
function readVersion(backupPath: string): number {
  const db = new Database(backupPath, { readonly: true });
  try {
    const { quick_check: check } = db.query('PRAGMA quick_check').get() as { quick_check: string };
    if (check !== 'ok') throw new Error(`${backupPath} is not intact: quick_check says ${check}`);
    const { user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number };
    if (version > LATEST_USER_VERSION) {
      throw new Error(
        `${backupPath} was written by a newer Bowerbird (schema ${version}, this build understands ${LATEST_USER_VERSION}). Upgrade before restoring it.`,
      );
    }
    return version;
  } finally {
    db.close();
  }
}

export async function restoreBackup(dbPath: string, backupPath: string): Promise<RestoreResult> {
  if (!existsSync(backupPath)) throw new Error(`no such backup: ${backupPath}`);
  if (path.resolve(backupPath) === path.resolve(dbPath)) throw new Error('the backup and the catalogue are the same file');
  const version = readVersion(backupPath);

  let movedAside: string | null = null;
  if (existsSync(dbPath)) {
    movedAside = `${dbPath}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(dbPath, movedAside);
    for (const suffix of SIDECARS) {
      if (existsSync(`${dbPath}${suffix}`)) await rename(`${dbPath}${suffix}`, `${movedAside}${suffix}`);
    }
  }

  await copyFile(backupPath, dbPath);
  return { movedAside, version };
}

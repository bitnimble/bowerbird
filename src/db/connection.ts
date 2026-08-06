import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { backupsDir } from '../utils/paths';
import { runMigrations } from './migrations';

// Opening creates, which is right for a first run and dangerous for every run
// after it: anything that leaves `DB_PATH` absent - a volume that failed to mount,
// a restore killed between its renames, a path edited by one character - otherwise
// gets a silent, empty replacement catalogue that the app is perfectly happy with.
//
// Backups sitting beside it are the evidence that this is not a first run, and the
// consequences of carrying on are all silent: the user sees an empty library and
// re-adds their folder, a rescan writes into the replacement, and the rolling
// backup starts taking snapshots of it - which rotate the real catalogue's history
// away within `backup_keep` runs, a week at the defaults, every run logging success
// (§4.9).
//
// Guarding it here rather than in rotation is the difference between a fix and a
// bandage. Rotation was where this was caught, so rotation is where it was first
// patched - by refusing to act on a snapshot with no libraries - and that guard is
// defeated by the very next thing a user does, which is re-add their library.
/**
 * Whether there is no catalogue at this path - counting an *empty* database as
 * none.
 *
 * A file with no tables in it is the same hazard as no file at all, and neither
 * `existsSync` nor a size test sees it: SQLite reads a zero-byte file as an empty
 * database, and the placeholder a killed restore leaves behind to hold its lock is
 * a perfectly valid 4096-byte one. Either way the next start builds the schema
 * straight into it and calls it a catalogue.
 *
 * Unreadable or locked counts as present, deliberately: this decides whether to
 * refuse, and something we cannot open is not something to refuse over.
 */
export function isMissingCatalogue(dbPath: string): boolean {
  const stats = statSync(dbPath, { throwIfNoEntry: false });
  if (stats == null || stats.size === 0) return true;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const { n } = db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
      return n === 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function refuseToReplaceAMissingCatalogue(dbPath: string): void {
  if (dbPath === ':memory:' || !isMissingCatalogue(dbPath)) return;
  const dir = backupsDir(dbPath);
  const prefix = `${path.basename(dbPath)}-`;
  const snapshots = existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.db')) : [];
  if (snapshots.length === 0) return;
  throw new Error(
    `${dbPath} is missing, but ${snapshots.length} backup(s) of it sit in ${dir}. ` +
      'Starting would create an empty catalogue and, within a week, roll those backups away. ' +
      'Put one back with `bun run restore latest`, or delete that directory if you meant to start over.',
  );
}

// Opens (creating if needed) the SQLite database, enables the pragmas the schema
// relies on, and applies migrations. FK enforcement is off by default in
// bun:sqlite and must be set per connection (DESIGN §4). WAL + a busy timeout let
// concurrent per-library syncs read while writes serialize.
export function createDatabase(dbPath: string): Database {
  refuseToReplaceAMissingCatalogue(dbPath);
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  // A checkpoint rewinds the WAL to be overwritten rather than shrinking it, so
  // without this the file keeps the high-water mark of the worst burst forever, and
  // the backup's long-lived read transaction is what pushes that mark up (§4.9).
  // Four times the autocheckpoint threshold at this build's page size, so ordinary
  // load never reaches it. Per connection rather than a property of the database.
  db.exec('PRAGMA journal_size_limit = 16777216;');
  runMigrations(db);
  return db;
}

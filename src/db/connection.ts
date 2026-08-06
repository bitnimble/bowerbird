import { Database } from 'bun:sqlite';
import { runMigrations } from './migrations';

// Opens (creating if needed) the SQLite database, enables the pragmas the schema
// relies on, and applies migrations. FK enforcement is off by default in
// bun:sqlite and must be set per connection (DESIGN §4). WAL + a busy timeout let
// concurrent per-library syncs read while writes serialize.
export function createDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  // Hands the WAL's disk space back after a burst. A checkpoint rewinds the WAL to
  // be overwritten from the start rather than shrinking it, so the file keeps
  // whatever high-water mark it has ever reached, for the life of the database. Under
  // ordinary load that mark is the autocheckpoint threshold and this never fires:
  // measured, 40MB written in small commits holds the WAL at 3.9MB. What overshoots
  // it is a long-lived *reader*, which pins the snapshot a checkpoint would have to
  // pass - and the backup's `VACUUM INTO` (§4.9) is exactly one. With a reader held
  // open across that same 40MB, the WAL reached 120MB and stayed there, because every
  // version of every page touched has to be kept while somebody may still read the
  // old one.
  //
  // 16MB is four times the autocheckpoint threshold: clear of anything normal
  // operation reaches, low enough to reclaim a blowup like that. Applied at the next
  // reset rather than by the checkpoint itself, so the space comes back once writing
  // resumes and wraps - no idle detection, and nothing that takes the write lock to
  // truncate while the server is busy.
  db.exec('PRAGMA journal_size_limit = 16777216;');
  runMigrations(db);
  return db;
}

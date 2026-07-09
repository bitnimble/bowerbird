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
  runMigrations(db);
  return db;
}

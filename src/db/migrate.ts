import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { newId } from '../schemas/id';
import { DEFAULT_SETTINGS } from '../schemas/settings';
import type { Database } from './driver';
import { triggers } from './triggers';

const MIGRATIONS = join(import.meta.dir, 'migrations');

/**
 * The one index drizzle-kit cannot carry, applied at startup beside the triggers.
 *
 * `SQLiteSquasher.squashIdx` joins an index's columns with a comma and `unsquashIdx` splits them
 * back on one, so any expression holding a comma is torn in half and emitted as two bogus columns.
 * `json_extract(recipe, '$.path')` is exactly that shape, and the spelling is not negotiable: the
 * planner only reaches an expression index when the query names the same expression, and
 * `photo_paths_repository.PATH_OF` is what the queries name.
 *
 * Here rather than in `schema/`, which `drizzle.config.ts` reads as the tables to diff: this is not
 * one, and a file of raw SQL sitting among them reads as though drizzle-kit were managing it.
 */
const EXPRESSION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_photos_path ON photos(library_id, json_extract(recipe, '$.path'));
`;

/**
 * When the newest migration this build ships was generated, as drizzle's journal records it.
 *
 * The unit of comparison for "was this catalogue written by a newer Bowerbird": every schema change
 * is a migration and every migration is stamped, so there is no way to move the schema without
 * moving this.
 */
let latest: number | null = null;

export function latestMigrationMillis(): number {
  // The journal is read in ascending order, so the newest is the last of it.
  latest ??= journal().at(-1)!.when;
  return latest;
}

/** The newest migration a catalogue has had applied, or 0 for one that has had none. */
export function appliedMigrationMillis(db: Database): number {
  const table = db
    .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (table == null) return 0;
  const row = db.query('SELECT MAX(created_at) AS newest FROM __drizzle_migrations').get() as {
    newest: number | null;
  };
  return row.newest ?? 0;
}

interface JournalEntry {
  when: number;
  tag: string;
}

function journal(): JournalEntry[] {
  const read = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return [...read.entries].sort((a, b) => a.when - b.when);
}

/**
 * Applies what drizzle-kit generated and has not been applied here yet.
 *
 * Written out rather than taken from `drizzle-orm`'s migrator, for one reason worth stating: that
 * migrator opens its transaction and *then* issues `PRAGMA foreign_keys=OFF`, where the pragma is a
 * documented no-op inside a transaction. A generated table rebuild drops the old table with the
 * keys still enforced, and every cascading child goes with it. The order below is the one that
 * works, and it is three lines.
 */
function applyMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at NUMERIC
  )`);
  const applied = appliedMigrationMillis(db);
  const owed = journal().filter((entry) => entry.when > applied);
  if (owed.length === 0) return;

  // Restored rather than turned on afterwards: whether keys are enforced is the connection's
  // business, and `createDatabase` is what decides it. A migration that left them on would enforce
  // them on a connection that had asked for them off.
  const enforcing = (db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined)?.foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const entry of owed) {
      const sql = readFileSync(join(MIGRATIONS, `${entry.tag}.sql`), 'utf8');
      db.transaction(() => {
        for (const statement of sql.split('--> statement-breakpoint')) {
          const trimmed = statement.trim();
          if (trimmed !== '') db.exec(trimmed);
        }
        db.query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(entry.tag, entry.when);
      })();
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${enforcing === 1 ? 'ON' : 'OFF'}`);
  }
}

export function runMigrations(db: Database): void {
  applyMigrations(db);
  db.exec(EXPRESSION_INDEXES);
  // After the migrations, always: a rebuilt table comes back without the triggers it had.
  db.exec(triggers());
  seedIdentity(db);
  seedSettings(db);
}

// Minted once and never again: it is what every stamp this machine writes is signed with, and what
// other peers key their version vectors by. Changing it would make this peer a stranger to its own
// writes.
function seedIdentity(db: Database): void {
  db.query('INSERT OR IGNORE INTO replication_identity (singleton, peer_id, name) VALUES (1, ?, ?)').run(
    newId(),
    hostname() || 'This device',
  );
}

// The shipped defaults as rows, so a fresh database holds what the app is running on rather than
// leaving every untouched key implicit and readable only from the schema. `OR IGNORE`, so this
// fills in a key a later version adds and never overwrites one somebody set.
//
// A null default is left absent rather than written as a string: an absent row already means
// "nothing chosen", which is what `last_viewer_rendition` is until a rendition has been.
function seedSettings(db: Database): void {
  const insert = db.query('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (value != null) insert.run(key, String(value));
  }
}

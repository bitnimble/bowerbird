// Several catalogues of one library, in one process, with nothing between them
// but a function call.
//
// The transport is not what any of the merge rules depend on, so the engine is
// tested where it actually lives: two SQLite databases in memory, replicated by
// calling `pull`. A run that would take a browser and a server minutes takes
// milliseconds here, which is what makes a randomised convergence property
// affordable enough to be the thing the design is actually held to.
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { Clock, DEFAULT_SKEW_MS } from '../clock';
import type { Replica } from '../session';
import { useClock } from '../stamps';

export const LIB = 'lib';

export interface Peer extends Replica {
  name: string;
  /**
   * Moves this peer's own clock on, which is how a test says "and *then* it did
   * this". Peers writing inside one millisecond are ordered by their counters and
   * peer ids - deterministic, but not program order.
   */
  advance: (byMs?: number) => void;
}

// Somewhere far from any real timestamp, so a stamp minted here is obviously not
// one the wall clock produced, and every run starts from the same instant.
const EPOCH = 1_700_000_000_000;

export function makePeer(name: string): Peer {
  const db = new Database(':memory:');
  // As `connection.ts` opens the real thing. Without it a cascade never fires, so
  // the peers here would agree about a deletion the running app does not.
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, ?, 'Trip')").run(LIB, `/photos/${name}`);
  db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIB);

  // A clock the test drives rather than the system's. Every stamp in a run is
  // then a function of the seed alone, so a failure replays exactly - which is
  // the whole reason the seed is printed.
  let now = EPOCH;
  const peer = db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string };
  useClock(db, new Clock(peer.peer_id, DEFAULT_SKEW_MS, () => now));
  return { name, db, libraryId: LIB, advance: (byMs = 5) => (now += byMs) };
}

/**
 * A deterministic pseudo-random source.
 *
 * Its own rather than `Math.random` so a failing seed can be replayed exactly:
 * a convergence bug that only appears in one interleaving is no use if the
 * interleaving cannot be got back.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    this.state >>>= 0;
    return this.state / 0x1_0000_0000;
  }

  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  /** An id of the shape the app mints, but from the seed. */
  id(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 16 }, () => alphabet[this.int(alphabet.length)]!).join('');
  }
}

/**
 * Everything about a library that is supposed to be the same on every peer, keyed
 * by row.
 *
 * Row by row rather than as one blob so that a divergence reads as "the laptop
 * has this photograph and the server does not", which is a sentence, instead of
 * two four-kilobyte JSON strings a reader has to diff by eye.
 */
export function replicatedRows(db: Database): Map<string, string> {
  const rows = new Map<string, string>();
  const dump = (label: string, sql: string, key: (row: Record<string, unknown>) => string): void => {
    for (const row of db.query(sql).all() as Record<string, unknown>[]) {
      rows.set(`${label} ${key(row)}`, JSON.stringify(row));
    }
  };
  dump(
    'photo',
    `SELECT id, library_id, shoot_id, recipe, is_deleted, deleted_from_path, rating, triage, notes,
            stack_state, is_hidden, content_hash, width, height, date_added,
            stamp_imported, stamp_triage, stamp_placement, stamp_bin, stamp_stack, stamp_hidden
       FROM photos ORDER BY id`,
    (row) => String(row.id),
  );
  dump(
    'shoot',
    'SELECT id, library_id, parent_id, folder_path, name, description, ordering, is_hidden, stamp, stamp_hidden, stamp_folder FROM shoots ORDER BY id',
    (row) => String(row.id),
  );
  dump(
    'stack',
    `SELECT id, library_id, origin, date_created, created_stamp, stamp
       FROM stacks ORDER BY id`,
    (row) => String(row.id),
  );
  dump(
    'stack_member',
    'SELECT stack_id, photo_id, stamp FROM stack_members ORDER BY stack_id, photo_id',
    (row) => `${row.stack_id}/${row.photo_id}`,
  );
  dump(
    'folder_rule',
    'SELECT library_id, folder_path, rule, stamp FROM folder_rules ORDER BY folder_path',
    (row) => String(row.folder_path),
  );
  dump('shoot_banner', 'SELECT shoot_id, photo_id, stamp FROM shoot_banners ORDER BY shoot_id', (row) =>
    String(row.shoot_id),
  );
  // Every replicated column, not a readable subset: a column left out of this is
  // one no seed can ever disagree about, and `updated_at` hid a peer that stopped
  // rebuilding its renditions behind exactly that gap.
  dump(
    'photo_edits',
    'SELECT photo_id, doc, cursor, session_id, chain, updated_at, stamp FROM photo_edits ORDER BY photo_id',
    (row) => String(row.photo_id),
  );
  dump('photo_edit_history', 'SELECT photo_id, deltas FROM photo_edit_history ORDER BY photo_id', (row) =>
    String(row.photo_id),
  );
  // The library's own settings replicate too, and the walk renames it. Without
  // this the rename ran on every seed and nothing ever looked at the result.
  dump(
    'library',
    `SELECT id, name, ordering, bin_name, include_subfolders, auto_stack,
            auto_stack_similarity, auto_stack_window_seconds, rendition_source, rendition_hdr, stamp
       FROM libraries ORDER BY id`,
    (row) => String(row.id),
  );
  // Deliberately not `edit_conflicts`. A parked candidate carries the stamp of
  // the peer whose edit it is, so it can never be streamed *to* that peer, whose
  // coverage of its own origin is total - which `parkDivergentEdits` says in as
  // many words. Each peer that ever holds both sides rebuilds them from the same
  // bytes instead, and a peer that only ever saw the winner has nothing to
  // resolve and correctly holds none. What does converge is the document, and the
  // resolution when somebody picks one, which is an ordinary edit.
  dump(
    'blob_location',
    'SELECT library_id, photo_id, peer_id, stamp FROM blob_locations ORDER BY photo_id, peer_id',
    (row) => `${row.photo_id}/${row.peer_id}`,
  );
  return rows;
}

/**
 * What the log says about one row, which is the first question to ask of a peer
 * that is missing it: absent because nobody told it, or absent because it buried
 * it and will refuse to hear otherwise?
 */
function verdict(peer: Peer, key: string): string {
  const [kind, rowId] = key.split(' ');
  const rows = peer.db
    .query('SELECT entity, stamp, deleted FROM replication_log WHERE library_id = ? AND row_id = ?')
    .all(LIB, rowId ?? '') as { entity: string; stamp: string; deleted: number }[];
  const mine = rows.filter((row) => row.entity === kind || row.entity.startsWith(`${kind}.`));
  if (mine.length === 0) return `no log entry at all; vector ${vectorOf(peer)}`;
  return `${mine.map((row) => `${row.entity}${row.deleted === 1 ? ' BURIED' : ''}@${row.stamp}`).join(', ')}; vector ${vectorOf(peer)}`;
}

// The vector beside the verdict, because the two together are the whole answer:
// a peer missing a row it has been told about is a merge bug, and a peer missing
// one whose origin its vector already claims is a delivery bug.
function vectorOf(peer: Peer): string {
  const rows = peer.db
    .query('SELECT origin, stamp FROM replication_vectors WHERE library_id = ? ORDER BY origin')
    .all(LIB) as { origin: string; stamp: string }[];
  return rows.map((row) => `${row.origin}=${row.stamp}`).join(' ');
}

/** The rows two peers disagree about, as lines a person can read. */
export function differences(a: Peer, b: Peer): string[] {
  const left = replicatedRows(a.db);
  const right = replicatedRows(b.db);
  const complaints: string[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const here = left.get(key);
    const there = right.get(key);
    if (here === there) continue;
    if (here == null)
      complaints.push(
        `${key}: only ${b.name} has it\n  ${b.name}: ${there}\n  ${b.name} log: ${verdict(b, key)}\n  ${a.name} log: ${verdict(a, key)}`,
      );
    else if (there == null)
      complaints.push(
        `${key}: only ${a.name} has it\n  ${a.name}: ${here}\n  ${a.name} log: ${verdict(a, key)}\n  ${b.name} log: ${verdict(b, key)}`,
      );
    else complaints.push(`${key}:\n  ${a.name}: ${here}\n  ${b.name}: ${there}`);
  }
  return complaints;
}

/** The same, as one string, for the places that just want to compare two peers. */
export function replicatedState(db: Database): string {
  const parts: string[] = [];
  const dump = (label: string, sql: string): void => {
    const rows = db.query(sql).all() as Record<string, unknown>[];
    parts.push(`${label}: ${JSON.stringify(rows)}`);
  };
  dump(
    'photos',
    `SELECT id, library_id, shoot_id, recipe, is_deleted, deleted_from_path, rating, triage, notes,
            stack_state, is_hidden, content_hash, width, height, date_added,
            stamp_imported, stamp_triage, stamp_placement, stamp_bin, stamp_stack, stamp_hidden
       FROM photos ORDER BY id`,
  );
  dump('shoots', 'SELECT id, library_id, parent_id, folder_path, name, description, ordering, is_hidden, stamp, stamp_hidden, stamp_folder FROM shoots ORDER BY id');
  dump(
    'stacks',
    `SELECT id, library_id, origin, date_created, created_stamp, stamp
       FROM stacks ORDER BY id`,
  );
  dump('stack_members', 'SELECT stack_id, photo_id, stamp FROM stack_members ORDER BY stack_id, photo_id');
  dump('folder_rules', 'SELECT library_id, folder_path, rule, stamp FROM folder_rules ORDER BY folder_path');
  dump('shoot_banners', 'SELECT shoot_id, photo_id, stamp FROM shoot_banners ORDER BY shoot_id');
  dump(
    'photo_edits',
    'SELECT photo_id, doc, cursor, session_id, chain, updated_at, stamp FROM photo_edits ORDER BY photo_id',
  );
  dump('photo_edit_history', 'SELECT photo_id, deltas FROM photo_edit_history ORDER BY photo_id');
  dump(
    'libraries',
    `SELECT id, name, ordering, bin_name, include_subfolders, auto_stack,
            auto_stack_similarity, auto_stack_window_seconds, rendition_source, rendition_hdr, stamp
       FROM libraries ORDER BY id`,
  );
  dump('blob_locations', 'SELECT library_id, photo_id, peer_id, stamp FROM blob_locations ORDER BY photo_id, peer_id');
  // The log is deliberately not compared. It is an index over what this replica
  // holds, not a fact about the library: a peer that never heard of a photograph
  // has no entry for it and a peer that did has a tombstone, and those are the
  // same state of knowledge reached from different directions. What it owes is
  // completeness about the rows that *are* here, which `invariants` checks.
  return parts.join('\n');
}

/** The invariants a peer has to hold whatever arrived, checked as a list of complaints. */
export function invariants(db: Database): string[] {
  const complaints: string[] = [];
  const drift = db
    .query(
      `SELECT p.id FROM photos p
        WHERE p.stack_id IS NOT (SELECT m.stack_id FROM stack_members m WHERE m.photo_id = p.id ORDER BY m.stack_id LIMIT 1)`,
    )
    .all() as { id: string }[];
  for (const row of drift) complaints.push(`${row.id}: stack_id disagrees with stack_members`);

  const unrepresented = db
    .query(
      `SELECT stack_id, COUNT(*) AS flagged FROM photos WHERE stack_id IS NOT NULL AND is_representative = 1
        GROUP BY stack_id HAVING flagged <> 1`,
    )
    .all() as { stack_id: string; flagged: number }[];
  for (const row of unrepresented) complaints.push(`${row.stack_id}: ${row.flagged} members stand for it`);

  // A binned photograph with nowhere to go back to. Both peers agreeing on it is
  // not enough - they can converge on the same wrong value, which is exactly what
  // carrying `deleted_from_path` on the placement unit produced - so it is asked
  // of each peer rather than compared between them. A restore in this state puts
  // the RAW in the library root.
  const rootless = db
    .query('SELECT id FROM photos WHERE is_deleted = 1 AND deleted_from_path IS NULL')
    .all() as { id: string }[];
  for (const row of rootless) complaints.push(`${row.id}: binned with no path to go back to`);

  const orphans = db
    .query('SELECT id FROM photos WHERE shoot_id IS NOT NULL AND shoot_id NOT IN (SELECT id FROM shoots)')
    .all() as { id: string }[];
  for (const row of orphans) complaints.push(`${row.id}: points at a shoot that is gone`);

  // The safety net for every way a row can leave without anyone meaning it to -
  // a foreign key cascade above all, which SQLite performs and no code sees. A
  // live log entry whose row has gone is a change no peer will ever be sent, and
  // it makes the sender skip the entry for ever rather than say anything.
  for (const [entity, table, key] of [
    ['photo.triage', 'photos', 'id'],
    ['photo.hidden', 'photos', 'id'],
    ['shoot', 'shoots', 'id'],
    ['shoot.folder', 'shoots', 'id'],
    ['shoot.hidden', 'shoots', 'id'],
    ['stack', 'stacks', 'id'],
    ['shoot_banner', 'shoot_banners', 'shoot_id'],
    ['photo_edits', 'photo_edits', 'photo_id'],
    ['folder_rule', 'folder_rules', 'folder_path'],
  ] as const) {
    const stale = db
      .query(
        `SELECT row_id FROM replication_log
           WHERE entity = ? AND deleted = 0 AND row_id NOT IN (SELECT ${key} FROM ${table})`,
      )
      .all(entity) as { row_id: string }[];
    for (const row of stale) complaints.push(`${entity} ${row.row_id}: logged as live, but the row has gone`);
  }
  for (const [entity, joined] of [
    ['stack_member', "SELECT stack_id || '/' || photo_id FROM stack_members"],
    ['edit_conflict', "SELECT photo_id || '/' || session_id FROM edit_conflicts"],
  ] as const) {
    const stale = db
      .query(`SELECT row_id FROM replication_log WHERE entity = ? AND deleted = 0 AND row_id NOT IN (${joined})`)
      .all(entity) as { row_id: string }[];
    for (const row of stale) complaints.push(`${entity} ${row.row_id}: logged as live, but the row has gone`);
  }

  // And the other direction: a row nothing in the log names is a row no peer will
  // ever be told about, which is the quietest way to lose a photograph there is.
  const unlogged = db
    .query(
      `SELECT id FROM photos WHERE stamp_triage IS NOT NULL
         AND id NOT IN (SELECT row_id FROM replication_log WHERE entity = 'photo.triage' AND deleted = 0)`,
    )
    .all() as { id: string }[];
  for (const row of unlogged) complaints.push(`${row.id}: has a verdict the log does not name`);

  return complaints;
}

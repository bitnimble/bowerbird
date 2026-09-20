import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { type Cell, type Change, PAGE_ROWS, type Page } from '../../schemas/replication';
import { entityOf, payloadColumns, type ReplicatedEntity } from './entities';
import { floor, lacks, type Vector } from './vectors';

// What one peer sends another (docs/replication.md §6.2).

const log = new Logger('replication');

/**
 * The changes a holder of `held` is missing, oldest first.
 *
 * Read from one snapshot by the caller's transaction: what a sender claims to
 * have delivered is its coverage *as of that snapshot*, and a stream that saw
 * some rows from before a concurrent write and some from after could honestly
 * claim neither.
 */
export function page(db: Database, libraryId: string, held: Vector, after: string, limit = PAGE_ROWS): Page {
  // The scan starts at the lowest coverage of any origin, because an origin the
  // holder has never heard of is one it needs from the beginning. Rows above that
  // floor are then filtered per origin, which is the comparison that decides.
  //
  // The cursor is the full index key, not the stamp alone: one action stamps
  // many rows (a batch bin, the pairing walk stamping a whole library), so a
  // page can end mid-tie, and resuming from `stamp > cursor` would silently
  // skip the rest of the tie.
  const origins = originsInLog(db, libraryId);
  const resume = decodeCursor(after);
  const rows = (
    resume == null
      ? db
          .query(
            `SELECT entity, row_id, stamp, deleted FROM replication_log
               WHERE library_id = ? AND stamp > ? ORDER BY stamp, entity, row_id LIMIT ?`,
          )
          .all(libraryId, floor(held, origins), limit)
      : db
          .query(
            `SELECT entity, row_id, stamp, deleted FROM replication_log
               WHERE library_id = ? AND (stamp, entity, row_id) > (?, ?, ?)
               ORDER BY stamp, entity, row_id LIMIT ?`,
          )
          .all(libraryId, resume.stamp, resume.entity, resume.rowId, limit)
  ) as { entity: string; row_id: string; stamp: string; deleted: number }[];

  const changes = new Map<string, Change>();
  for (const row of rows) {
    if (!lacks(held, row.stamp)) continue;
    const entity = entityOf(row.entity);
    const at = `${entity.kind} ${row.row_id}`;
    // A row id that cannot be taken apart is one no peer could apply, and a page is
    // rebuilt from the same log position every session - so throwing over it stops
    // this catalogue streaming to anybody, for good, over a row nobody can use. It
    // is not sent, and it is not what stops everything else being. Above the grave
    // as well as the row: a tombstone names the same id and lands in the same
    // `whereKey`, so sending one is asking the far side to fail on it instead.
    if (!parseable(entity, row.row_id)) {
      log.warn('skipping a log row whose id cannot be read', { entity: row.entity, row: row.row_id });
      continue;
    }
    if (row.deleted === 1) {
      changes.set(at, { kind: entity.kind, rowId: row.row_id, stamp: row.stamp, deleted: true });
      continue;
    }
    // One payload answers for every unit of a row, so a photograph whose verdict
    // and whose placement both moved is read once rather than once per unit.
    if (changes.has(at)) continue;
    const loaded = load(db, libraryId, entity, row.row_id);
    if (loaded != null) changes.set(at, loaded);
  }

  const last = rows[rows.length - 1];
  return {
    changes: [...changes.values()],
    cursor: last != null ? JSON.stringify([last.stamp, last.entity, last.row_id]) : after,
    done: rows.length < limit,
  };
}

function decodeCursor(after: string): { stamp: string; entity: string; rowId: string } | null {
  if (after === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(after);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) throw new AppError('VALIDATION_ERROR', 'malformed page cursor');
  const [stamp, entity, rowId] = parsed as unknown[];
  if (typeof stamp !== 'string' || typeof entity !== 'string' || typeof rowId !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'malformed page cursor');
  }
  return { stamp, entity, rowId };
}

function originsInLog(db: Database, libraryId: string): Set<string> {
  const rows = db
    .query('SELECT DISTINCT substr(stamp, 17) AS origin FROM replication_log WHERE library_id = ?')
    .all(libraryId) as { origin: string }[];
  return new Set(rows.map((row) => row.origin));
}

function load(db: Database, libraryId: string, entity: ReplicatedEntity, rowId: string): Change | null {
  const columns = payloadColumns(entity);
  const stampColumns = entity.units.map((unit) => unit.stamp);
  const where = whereKey(entity, rowId, libraryId);
  const row = db
    .query(`SELECT ${[...columns, ...stampColumns].join(', ')} FROM ${entity.table} WHERE ${where.sql}`)
    .get(...where.params) as Record<string, Cell> | null;
  if (row == null) return null;

  const stamps: Record<string, string> = {};
  for (const unit of entity.units) {
    const stamp = row[unit.stamp];
    delete row[unit.stamp];
    if (typeof stamp === 'string') stamps[unit.entity] = stamp;
  }

  return { kind: entity.kind, rowId, deleted: false, row, stamps, sidecar: sidecarOf(db, entity, rowId) };
}

function sidecarOf(db: Database, entity: ReplicatedEntity, rowId: string): Record<string, Cell> | null {
  if (entity.sidecar == null) return null;
  const side = whereSidecar(entity, rowId);
  return (
    (db
      .query(`SELECT ${entity.sidecar.columns.join(', ')} FROM ${entity.sidecar.table} WHERE ${side.sql}`)
      .get(...side.params) as Record<string, Cell> | null) ?? null
  );
}

/**
 * A row id back into the columns it spells, or null where it spells none.
 *
 * The one place the log's join is undone. Everything that takes a row id apart -
 * the SQL below, the payload check the apply makes, the page that decides whether
 * to send a row at all - asks this, so none of them can hold a different opinion
 * about what a well-formed id is. Two of them holding different opinions is what
 * let a row nobody could read stop a library replicating: the side that streamed
 * it thought it was fine and the side that applied it threw.
 */
export function keyPartsOf(rowId: string, key: readonly string[]): readonly string[] | null {
  const parts = key.length === 1 ? [rowId] : rowId.split('/');
  return parts.length === key.length ? parts : null;
}

/** Whether a row id has the shape a key needs, which everything below insists on. */
export function parseable(entity: ReplicatedEntity, rowId: string): boolean {
  return keyPartsOf(rowId, entity.key) != null;
}

/**
 * A row's key as SQL, from the id the log recorded.
 *
 * Composite keys are joined with a slash in the log (`units.ts`) and split back
 * here: the alphabet ids are drawn from holds no slash, so the pair cannot be
 * ambiguous about where one id ends.
 */
export function whereKey(entity: ReplicatedEntity, rowId: string, libraryId: string): { sql: string; params: string[] } {
  const clause = keyClause(entity, rowId);
  if (entity.libraryColumn == null) return clause;
  return { sql: [`${entity.libraryColumn} = ?`, clause.sql].join(' AND '), params: [libraryId, ...clause.params] };
}

// Not `whereKey`: a sidecar table holds nothing but sidecars, so it has no library
// column to scope by, and the row id it is keyed on is its owner's.
export function whereSidecar(entity: ReplicatedEntity, rowId: string): { sql: string; params: string[] } {
  return keyClause(entity, rowId);
}

function keyClause(entity: ReplicatedEntity, rowId: string): { sql: string; params: string[] } {
  // A composite id with the wrong number of parts would bind fewer parameters
  // than the statement has placeholders, which SQLite raises as an error nothing
  // above here expects: the page's transaction rolls back, the vector stays where
  // it was, and the same malformed row arrives and fails again every session
  // afterwards. Named as what it is instead, so the session fails loudly and the
  // peer that sent it is the one recorded as failing (§8.6).
  const parts = keyPartsOf(rowId, entity.key);
  if (parts == null) {
    throw new AppError('VALIDATION_ERROR', `a ${entity.kind} id must have ${entity.key.length} part(s): ${rowId}`);
  }
  return { sql: entity.key.map((column) => `${column} = ?`).join(' AND '), params: [...parts] };
}

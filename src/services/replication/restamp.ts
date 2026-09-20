import type { Database } from '../../db/driver';
import { Logger } from '../../logger';
import { observeStamp, stamp } from './stamps';
import { REPLICATED_UNITS } from './units';

// Restoring a backup onto a peer that replicates (docs/replication.md §8.2).
//
// The catalogue on disk is now a week old and the peers are not. Left alone, the
// first session hands the newer state straight back and the restore is undone
// minutes after it finished - which is the one outcome nobody restoring a backup
// wants, and it happens silently.

const log = new Logger('replication');

/** The newest stamp a catalogue has recorded, or null for one that has none. */
export function newestStamp(db: Database): string | null {
  const row = db.query('SELECT MAX(stamp) AS newest FROM replication_log').get() as { newest: string | null } | null;
  return row?.newest ?? null;
}

/**
 * Re-stamps every replicated row so the restored state is what the peers take.
 *
 * One stamp for the whole walk, because it is one thing the person did, and above
 * the *pre-restore* clock rather than the restored catalogue's own - stamps from
 * the week that is being rolled back are already out there on other peers, and a
 * clock that only knows what the backup knew would mint below them and lose.
 *
 * **What this does not do is delete.** Rows the peers have and the backup does not
 * - photographs imported since - arrive as usual on the next session and are kept.
 * The restore is a statement about the values it holds, not a claim that nothing
 * has happened since; rolling the catalogue back a week should not throw away a
 * card imported on Tuesday.
 */
export function restampRestored(db: Database, floor: string | null): number {
  const libraries = db.query('SELECT library_id FROM replication_libraries').all() as { library_id: string }[];
  if (libraries.length === 0) return 0;

  // Taken through the ordinary clock, which resumes from this catalogue's own log,
  // then lifted past whatever the catalogue being replaced had reached. A floor the
  // clock refuses is a corrupt or hand-edited value - a parked catalogue's own
  // stamps were minted on this machine and cannot be beyond the skew bound - and
  // the restore goes ahead on the clock it has rather than failing over it.
  if (floor != null && !observeStamp(db, floor)) {
    log.warn('the replaced catalogue had an unreadable clock; re-stamping from this one', { floor });
  }
  const at = stamp(db);

  const byTable = new Map<string, typeof REPLICATED_UNITS>();
  for (const unit of REPLICATED_UNITS) byTable.set(unit.table, [...(byTable.get(unit.table) ?? []), unit]);

  let rows = 0;
  db.transaction(() => {
    // Renders keep up with the settings they were built from. Staleness is decided
    // by holding `photo_edits.stamp` against the stamp each variant recorded, and this
    // walk lifts every edit stamp - so a render that was current before the restore
    // reads as owed after it, and the next start re-renders every edited photograph
    // in every replicated library. The rows are this device's own and travel nowhere,
    // so moving their stamps alongside says the same thing they said before. A variant
    // that was already stale keeps its old value, which is below the new floor and so
    // still reads as stale.
    for (const library of libraries) {
      db.query(
        `UPDATE renditions SET built_from = ?
          WHERE built_from IS NOT NULL
            AND EXISTS (SELECT 1 FROM photos p JOIN photo_edits e ON e.photo_id = p.id
                         WHERE p.id = renditions.photo_id AND p.library_id = ?
                           AND renditions.built_from >= e.stamp)`,
      ).run(at, library.library_id);
    }
    for (const units of byTable.values()) {
      const sets = units.map((unit) => `${unit.stamp} = ?`).join(', ');
      const scope = units[0]!.library.replaceAll('$.', '');
      const values = units.map(() => at);
      for (const library of libraries) {
        rows += db.query(`UPDATE ${units[0]!.table} SET ${sets} WHERE ${scope} = ?`).run(...values, library.library_id)
          .changes;
      }
    }
  })();
  log.info('re-stamped a restored catalogue so its state is the one that travels', { rows, at });
  return rows;
}


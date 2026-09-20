import type { Database } from '../../db/driver';
import { entityOf } from './entities';
import { stamp } from './stamps';

// What a hard delete leaves behind (docs/replication.md §3.6, §5.1).
//
// A row that is simply gone is indistinguishable from a row this peer has never
// heard of, and the second is what every other peer would conclude: they would
// send it straight back. So a deletion is a write like any other, carrying a
// stamp that a later write can beat and an earlier one cannot.

/**
 * Records that an entity has gone, replacing every unit row it had.
 *
 * The unit rows go because they describe columns that no longer exist; what
 * remains is one row saying the entity did, and when it stopped.
 *
 * **Nothing at all for a library that replicates with nobody**, matching the
 * triggers that log ordinary writes (§4). Taking a folder out of a library is one
 * click and tens of thousands of tombstones, and a catalogue nobody syncs should
 * pay for none of them - nor start its first pairing with a log that already has
 * opinions, which the pairing walk builds from the stamp columns.
 *
 * @param at the stamp the deletion carries. Stated by the caller rather than taken
 * here, because one action deleting many entities has to stamp them all the same:
 * defaulted, a loop reads as though it does and quietly gives each row its own.
 */
export function tombstone(db: Database, libraryId: string, kind: string, rowId: string, at: string): void {
  if (!replicates(db, libraryId)) return;
  const entity = entityOf(kind);
  const units = entity.units.map((unit) => unit.entity);
  const placeholders = units.map(() => '?').join(', ');
  db.query(
    `DELETE FROM replication_log
       WHERE library_id = ? AND row_id = ? AND deleted = 0 AND entity IN (${placeholders})`,
  ).run(libraryId, rowId, ...units);
  db.query(
    `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted) VALUES (?, ?, ?, ?, 1)
     ON CONFLICT (library_id, entity, row_id) DO UPDATE SET stamp = excluded.stamp, deleted = 1
       WHERE excluded.stamp > replication_log.stamp`,
  ).run(libraryId, entity.kind, rowId, at);
}

/**
 * Forgets that an entity was ever deleted, for one that has just come back.
 *
 * A row brought back by a write newer than the deletion is alive, and a log that
 * still holds its tombstone says both things at once - after which the stream
 * sends the tombstone rather than the row, and the peer receiving it deletes what
 * it was being given. The row's own entries describe it now; the grave is a
 * statement about a row that no longer applies.
 */
export function unbury(db: Database, libraryId: string, kind: string, rowId: string): void {
  db.query(
    'DELETE FROM replication_log WHERE library_id = ? AND entity = ? AND row_id = ? AND deleted = 1',
  ).run(libraryId, kind, rowId);
}

/** Whether this library is one whose changes are worth recording at all. */
export function replicates(db: Database, libraryId: string): boolean {
  return db.query('SELECT 1 FROM replication_libraries WHERE library_id = ?').get(libraryId) != null;
}

/**
 * Tombstones everything a foreign key is about to take with the row.
 *
 * SQLite performs a cascade itself and tells nobody, so a banner or a membership
 * removed because its photograph was is a row that left with no record of
 * leaving - which every other peer reads as a row this one has not heard of yet,
 * and sends straight back.
 *
 * **On a stamp minted here, not the parent's.** The parent's looks better: every
 * peer running the same fan-out would write the same tombstone, and the value
 * would need no agreeing on. It is also undeliverable, which is fatal. A peer
 * buries only the children *it* was holding, and a tombstone stamped inside
 * another peer's origin can never be sent to anyone already claiming coverage of
 * that origin - so a membership one peer created while a second deleted the
 * photograph ends up buried on the peers that saw both and alive on the peer that
 * made it, with no way left to say so. That was the one permanent divergence the
 * property test ever found, and it takes three peers and a resurrection to reach,
 * which is to say it would have been found in use rather than in a test.
 *
 * Minting locally makes it an ordinary write, so it travels like one. Peers do
 * then disagree about *when* the child died - each stamped its own - but they
 * exchange those tombstones like any other row and the log keeps the newest, so
 * the threshold a later write has to beat to bring the child back converges too.
 */
export function forgetCascade(
  db: Database,
  libraryId: string,
  kind: 'photo' | 'shoot' | 'stack',
  rowIds: readonly string[],
): void {
  if (rowIds.length === 0 || !replicates(db, libraryId)) return;
  const placeholders = rowIds.map(() => '?').join(', ');
  const swept: [string, string][] = [];
  const sweep = (sql: string, entity: string): void => {
    for (const row of db.query(sql).all(...rowIds) as { row_id: string }[]) swept.push([entity, row.row_id]);
  };

  if (kind === 'photo') {
    sweep(`SELECT shoot_id AS row_id FROM shoot_banners WHERE photo_id IN (${placeholders})`, 'shoot_banner');
    sweep(`SELECT photo_id AS row_id FROM photo_edits WHERE photo_id IN (${placeholders})`, 'photo_edits');
    // Parked candidates go with the photograph too, and left out of this sweep
    // they went without a word: the foreign key took the rows and the log kept
    // saying they were there, after which a peer asking for them is sent nothing
    // and told it has everything.
    sweep(
      `SELECT photo_id || '/' || session_id AS row_id FROM edit_conflicts WHERE photo_id IN (${placeholders})`,
      'edit_conflict',
    );
    // And who was holding the original. These carry no foreign key on purpose - a
    // retraction has to outlive the row it is about - so nothing removes them
    // when the photograph goes, and left standing they are a holder for a
    // photograph that no longer exists: a transfer queued against nothing, and a
    // sole-holder warning counting it.
    sweep(
      `SELECT photo_id || '/' || peer_id AS row_id FROM blob_locations WHERE photo_id IN (${placeholders})`,
      'blob_location',
    );
    // Removed here rather than by the foreign key, because there isn't one: the
    // rows would otherwise stay live in the table while the log said they had
    // gone, which is the disagreement the log is not allowed to have.
    db.query(`DELETE FROM blob_locations WHERE photo_id IN (${placeholders})`).run(...rowIds);
    sweep(
      `SELECT stack_id || '/' || photo_id AS row_id FROM stack_members WHERE photo_id IN (${placeholders})`,
      'stack_member',
    );
  } else if (kind === 'shoot') {
    sweep(`SELECT shoot_id AS row_id FROM shoot_banners WHERE shoot_id IN (${placeholders})`, 'shoot_banner');
  } else {
    sweep(
      `SELECT stack_id || '/' || photo_id AS row_id FROM stack_members WHERE stack_id IN (${placeholders})`,
      'stack_member',
    );
  }

  if (swept.length === 0) return;
  // One stamp for the fan-out: this peer learned of one deletion, so what it
  // writes about the rows that went with it is one event.
  const at = stamp(db);
  for (const [entity, rowId] of swept) tombstone(db, libraryId, entity, rowId, at);
}

/**
 * Every shoot a delete of these would take, descendants included.
 *
 * `parent_id` cascades, so deleting a shoot deletes the tree under it - and each
 * of those is a row other peers hold and would send back.
 */
export function shootsBelow(db: Database, shootIds: readonly string[]): string[] {
  const all = new Set<string>(shootIds);
  let frontier = [...shootIds];
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(', ');
    const children = db
      .query(`SELECT id FROM shoots WHERE parent_id IN (${placeholders})`)
      .all(...frontier) as { id: string }[];
    frontier = children.map((row) => row.id).filter((id) => !all.has(id));
    for (const id of frontier) all.add(id);
  }
  return [...all];
}

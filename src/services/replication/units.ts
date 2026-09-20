// What replicates, in the units a last-write-wins merge resolves one at a time
// (docs/replication.md §3).
//
// A unit is the thing a stamp covers and a conflict clobbers whole, chosen per
// "control": fields a photographer changes together move together, and fields
// they change independently must not clobber each other. Every replicated column
// of every table belongs to exactly one of these; a column in none of them is a
// column that silently does not replicate.

export interface ReplicatedUnit {
  /** What the replication log calls this unit. */
  entity: string;
  table: string;
  /** The column carrying this unit's stamp. */
  stamp: string;
  /**
   * The row's identity and its library, as SQL over the trigger's row alias.
   * `$` stands in for NEW or OLD.
   */
  rowId: string;
  library: string;
}

const OWN_LIBRARY = '$.library_id';

export const REPLICATED_UNITS: readonly ReplicatedUnit[] = [
  // Import facts: what the file is, and what the camera recorded. The same file
  // gives the same answers on every peer, so a conflict here is a formality.
  { entity: 'photo.imported', table: 'photos', stamp: 'stamp_imported', rowId: '$.id', library: OWN_LIBRARY },
  // The cull verdict.
  { entity: 'photo.triage', table: 'photos', stamp: 'stamp_triage', rowId: '$.id', library: OWN_LIBRARY },
  // Where the photograph sits in the tree. Apart from the bin, so a folder rename
  // - which rewrites a path on every photo under it - cannot clobber a binning
  // somebody made on another peer while it happened.
  { entity: 'photo.placement', table: 'photos', stamp: 'stamp_placement', rowId: '$.id', library: OWN_LIBRARY },
  { entity: 'photo.bin', table: 'photos', stamp: 'stamp_bin', rowId: '$.id', library: OWN_LIBRARY },
  // Only the human verdict. Membership itself is stack_members below, because a
  // pointer cannot carry two stacks at once and the merge needs to see the overlap.
  { entity: 'photo.stack', table: 'photos', stamp: 'stamp_stack', rowId: '$.id', library: OWN_LIBRARY },
  // Apart from the verdict: hiding a frame and rating it are separate decisions made at separate
  // times, and a rating arriving from another peer must not un-hide what somebody put away.
  { entity: 'photo.hidden', table: 'photos', stamp: 'stamp_hidden', rowId: '$.id', library: OWN_LIBRARY },

  { entity: 'shoot', table: 'shoots', stamp: 'stamp', rowId: '$.id', library: OWN_LIBRARY },
  // Where the folder is. Apart from the label and the ordering because a different hand writes it -
  // only the scan does, following a rename on disk - and because settling two peers who renamed onto
  // one folder has to move this stamp, which on the shared one would claim the label was rewritten
  // then too and drop an edit to it that was still on its way (§5.6).
  { entity: 'shoot.folder', table: 'shoots', stamp: 'stamp_folder', rowId: '$.id', library: OWN_LIBRARY },
  // Apart from the shoot's own fields, because `relocate` rewrites `folder_path` across a whole
  // subtree: on one stamp, any folder rename would carry a stale hidden flag over a fresh one.
  { entity: 'shoot.hidden', table: 'shoots', stamp: 'stamp_hidden', rowId: '$.id', library: OWN_LIBRARY },
  { entity: 'folder_rule', table: 'folder_rules', stamp: 'stamp', rowId: '$.folder_path', library: OWN_LIBRARY },
  { entity: 'stack', table: 'stacks', stamp: 'stamp', rowId: '$.id', library: OWN_LIBRARY },
  {
    entity: 'stack_member',
    table: 'stack_members',
    stamp: 'stamp',
    // The alphabet ids are drawn from holds no '/', so the pair cannot be
    // ambiguous about where one id ends.
    rowId: "$.stack_id || '/' || $.photo_id",
    library: OWN_LIBRARY,
  },
  // Which peer holds a photograph's original. Replicated because it is what tells
  // every other peer where a photograph can be fetched from, and what an eviction
  // has to consult before it removes the copy in front of it.
  {
    entity: 'blob_location',
    table: 'blob_locations',
    stamp: 'stamp',
    rowId: "$.photo_id || '/' || $.peer_id",
    library: OWN_LIBRARY,
  },
  // The library's own settings. The row is its own library.
  { entity: 'library', table: 'libraries', stamp: 'stamp', rowId: '$.id', library: '$.id' },
  {
    entity: 'shoot_banner',
    table: 'shoot_banners',
    stamp: 'stamp',
    rowId: '$.shoot_id',
    library: '(SELECT library_id FROM shoots WHERE id = $.shoot_id)',
  },
  {
    entity: 'photo_edits',
    table: 'photo_edits',
    stamp: 'stamp',
    rowId: '$.photo_id',
    library: '(SELECT library_id FROM photos WHERE id = $.photo_id)',
  },
  {
    entity: 'edit_conflict',
    table: 'edit_conflicts',
    stamp: 'stamp',
    rowId: "$.photo_id || '/' || $.session_id",
    library: '(SELECT library_id FROM photos WHERE id = $.photo_id)',
  },
];

function forRow(sql: string, row: 'NEW' | 'OLD'): string {
  return sql.replaceAll('$', row);
}

/**
 * The triggers that keep `replication_log` in step with the stamp columns.
 *
 * **The log is maintained by the database, not by whoever writes the row.** Most
 * of the ~40 write sites are keyed by photo id alone and never learn which
 * library they touched, so a hand-written log call at each would need that
 * threaded through every signature; a trigger has `NEW.library_id` for free. It
 * also makes the two impossible to drift: there is no way to move a stamp without
 * the log following.
 *
 * Only inserts and updates. A hard delete leaves its log entries standing, which
 * is inert while `replication_libraries` is empty - nothing can be logged, so
 * nothing can be stale - and is settled when tombstones land, since what a delete
 * should leave behind is a tombstone rather than an absence.
 *
 * **Nothing is logged for a library that does not replicate.** The stamp columns
 * are written regardless - the site that writes them has no cheap way to know -
 * but the rows behind them are what cost an import its write amplification, and a
 * catalogue nobody syncs should pay none of it. When a library is paired the log
 * is built from those same stamp columns, which is the rebuild the log's status
 * as an index promises.
 */
export function replicationTriggers(): string {
  return REPLICATED_UNITS.flatMap((unit) => {
    const name = `trg_repl_${unit.entity.replace('.', '_')}`;
    const guard = `NEW.${unit.stamp} IS NOT NULL
        AND EXISTS (SELECT 1 FROM replication_libraries WHERE library_id = ${forRow(unit.library, 'NEW')})`;
    const write = `INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted)
      VALUES (${forRow(unit.library, 'NEW')}, '${unit.entity}', ${forRow(unit.rowId, 'NEW')}, NEW.${unit.stamp}, 0)
      ON CONFLICT(library_id, entity, row_id) DO UPDATE SET stamp = excluded.stamp, deleted = 0
        WHERE excluded.stamp > replication_log.stamp;`;
    return [
      `CREATE TRIGGER IF NOT EXISTS ${name}_ins AFTER INSERT ON ${unit.table}
       WHEN ${guard} BEGIN ${write} END;`,
      `CREATE TRIGGER IF NOT EXISTS ${name}_upd AFTER UPDATE OF ${unit.stamp} ON ${unit.table}
       WHEN ${guard} BEGIN ${write} END;`,
    ];
  }).join('\n');
}

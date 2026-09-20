import type { Database } from '../../db/driver';
import { lacks, peerVectors, type Vector } from './vectors';

// Dropping tombstones nobody is left to need (docs/replication.md §8.3).
//
// By acknowledgement, never by age: a grave may go only once every known peer's
// vector has passed its stamp, because a vector past the stamp means the
// deletion was applied there and cannot be sent back. Age-based collection
// would reap a long-offline peer's own never-replicated deletions, which then
// resurrect everywhere on reconnect. The wall clock judges peers, not graves:
// a peer silent past the horizon is surfaced for the user to forget (§6.5),
// which removes it from the floor.

/**
 * Every peer whose opinion a grave has to wait on, and what it is known to hold.
 *
 * A peer that has been paired but has never finished a session counts, with an
 * empty vector, which holds up everything. It is not the same as a peer nobody
 * has heard of: a first session commits each page as it applies it, so one that
 * dropped halfway left real rows on that peer and moved no vector to say so. Reap
 * a grave it needed and it keeps the row for good, with nothing left to tell it -
 * and the peer that would notice is the one that never finished talking.
 */
function peersToWaitFor(db: Database, libraryId: string): Vector[] {
  const known = peerVectors(db, libraryId);
  const paired = db
    .query('SELECT peer_id FROM replication_peers WHERE library_id = ?')
    .all(libraryId) as { peer_id: string }[];
  for (const peer of paired) if (!known.has(peer.peer_id)) known.set(peer.peer_id, new Map());
  return [...known.values()];
}

/**
 * Drops every tombstone that every known peer's vector has passed.
 *
 * With no peers at all, everything goes: a peer this replica has neither paired
 * with nor heard from can only ever arrive as a fresh clone (§6.5), which holds
 * nothing a missing tombstone could resurrect.
 */
export function collectTombstones(db: Database, libraryId: string): number {
  const peers = peersToWaitFor(db, libraryId);
  const passed = graves(db, libraryId).filter((grave) => !peers.some((vector) => lacks(vector, grave.stamp)));
  if (passed.length === 0) return 0;
  // The stamp is part of the match: a deletion made since the read above rewrites
  // the grave with a newer stamp nobody has acknowledged yet.
  const drop = db.query(
    'DELETE FROM replication_log WHERE library_id = ? AND entity = ? AND row_id = ? AND deleted = 1 AND stamp = ?',
  );
  db.transaction(() => {
    for (const grave of passed) drop.run(libraryId, grave.entity, grave.row_id, grave.stamp);
  })();
  return passed.length;
}

/** The peers whose recorded vectors keep at least one tombstone from collection. */
export function peersHoldingUpCollection(db: Database, libraryId: string): string[] {
  const held = graves(db, libraryId);
  const known = peerVectors(db, libraryId);
  const paired = db
    .query('SELECT peer_id FROM replication_peers WHERE library_id = ?')
    .all(libraryId) as { peer_id: string }[];
  for (const peer of paired) if (!known.has(peer.peer_id)) known.set(peer.peer_id, new Map());
  const holding: string[] = [];
  for (const [peer, vector] of known) {
    if (held.some((grave) => lacks(vector, grave.stamp))) holding.push(peer);
  }
  return holding;
}

/**
 * Removes a peer from the GC floor.
 *
 * What the user-facing forget calls (§6.5, §8.4): the peer stops bounding
 * collection, and if it ever returns it is refused and re-pairs fresh, arriving
 * as a clone.
 */
export function forgetPeer(db: Database, libraryId: string, peerId: string): void {
  db.query('DELETE FROM replication_peer_vectors WHERE library_id = ? AND peer_id = ?').run(libraryId, peerId);
}

/**
 * The same sweep, for a library that is already gone (§8.4).
 *
 * `forgetLibrary` runs from a lifecycle listener, after the row is deleted and in
 * its own transaction, so a kill in between leaves exactly the state it exists to
 * prevent - and there is nothing left afterwards to notice, because noticing
 * means looking for a library that is not there. So it is looked for at startup,
 * which also collects whatever earlier builds left behind.
 */
export function forgetOrphanedLibraries(db: Database): number {
  const orphaned = db
    .query(
      `SELECT DISTINCT library_id FROM (
         SELECT library_id FROM replication_vectors
         UNION SELECT library_id FROM replication_peer_vectors
         UNION SELECT library_id FROM replication_log
         UNION SELECT library_id FROM blob_locations)
       WHERE library_id NOT IN (SELECT id FROM libraries)`,
    )
    .all() as { library_id: string }[];
  for (const row of orphaned) forgetLibrary(db, row.library_id);
  return orphaned.length;
}

/**
 * Everything a deleted library's replication state left behind.
 *
 * `replication_libraries` and `replication_peers` are cascaded away by their
 * foreign keys; these four carry none, because a tombstone has to outlive the row
 * it describes. Outliving the *library* is a different thing, and letting them is
 * a trap: the id a replica is created under is the remote's, verbatim, so deleting
 * a synced library and adding it again lands on the same `library_id`. The stale
 * vector then claims coverage of everything the first copy had applied, the sender
 * skips exactly those rows as already held, and the reader gets a library that
 * reports success, has a peer, shows no error, and is empty. Nothing heals it
 * either: a vector only ever rises.
 */
export function forgetLibrary(db: Database, libraryId: string): void {
  db.transaction(() => {
    db.query('DELETE FROM replication_vectors WHERE library_id = ?').run(libraryId);
    db.query('DELETE FROM replication_peer_vectors WHERE library_id = ?').run(libraryId);
    db.query('DELETE FROM replication_log WHERE library_id = ?').run(libraryId);
    // The fourth table with no foreign key, and the one whose survival is quietest:
    // photo ids are the remote's verbatim too, so a re-add finds this device still
    // claiming to hold originals it deleted with the library. `record` short-circuits
    // on the existing row and the "originals this peer lacks" diff is empty, so the
    // bulk fetch queues nothing and the grid shows a full library over an empty root.
    db.query('DELETE FROM blob_locations WHERE library_id = ?').run(libraryId);
  })();
}

interface Grave {
  entity: string;
  row_id: string;
  stamp: string;
}

function graves(db: Database, libraryId: string): Grave[] {
  return db
    .query('SELECT entity, row_id, stamp FROM replication_log WHERE library_id = ? AND deleted = 1')
    .all(libraryId) as Grave[];
}

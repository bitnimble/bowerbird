import type { Database } from '../../db/driver';
import { stampPeer } from './clock';
import { peerId } from './stamps';

// What a replica has, and what it believes its peers have (docs/replication.md §6.1).
//
// A version vector maps an origin - the peer that minted a stamp, which the stamp
// itself carries - to the highest stamp from that origin below which *everything*
// has been applied. "Below which everything" is the whole of it: the vector is a
// claim about completeness, not a high-water mark of what happened to arrive.

export type Vector = Map<string, string>;

/**
 * What this replica holds for a library.
 *
 * Its own writes are not stored, they are asked of the clock: everything this
 * peer has ever minted is by definition applied here, and recording that on every
 * write would be a second write for every first one.
 */
export function coverage(db: Database, libraryId: string): Vector {
  const vector = remoteCoverage(db, libraryId);
  const self = peerId(db);
  const own = db
    .query('SELECT MAX(stamp) AS newest FROM replication_log WHERE library_id = ? AND substr(stamp, 17) = ?')
    .get(libraryId, self) as { newest: string | null } | undefined;
  if (own?.newest != null) vector.set(self, own.newest);
  return vector;
}

function remoteCoverage(db: Database, libraryId: string): Vector {
  const rows = db
    .query('SELECT origin, stamp FROM replication_vectors WHERE library_id = ?')
    .all(libraryId) as { origin: string; stamp: string }[];
  return new Map(rows.map((row) => [row.origin, row.stamp]));
}

/**
 * Takes on what a sender has just finished proving it delivered.
 *
 * **Elementwise, and never past what the sender itself held.** A single
 * high-water mark over the stream would claim coverage of every origin up to it,
 * including origins the sender was behind on - after which this replica would
 * never ask anyone for that work again, and a write would be lost between peers
 * that are both alive and both syncing.
 */
export function advance(db: Database, libraryId: string, sender: Vector): void {
  const mine = remoteCoverage(db, libraryId);
  const self = peerId(db);
  const write = db.query(
    `INSERT INTO replication_vectors (library_id, origin, stamp) VALUES (?, ?, ?)
     ON CONFLICT (library_id, origin) DO UPDATE SET stamp = excluded.stamp WHERE excluded.stamp > replication_vectors.stamp`,
  );
  for (const [origin, stamp] of sender) {
    // This peer's own coverage of itself is the clock's business, and taking a
    // remote's word for it would let a stale peer talk this one into believing it
    // was missing its own writes.
    if (origin === self) continue;
    const held = mine.get(origin);
    if (held != null && held >= stamp) continue;
    write.run(libraryId, origin, stamp);
  }
}

/** A vector as JSON carries it, and back. */
export function packVector(vector: Vector): Record<string, string> {
  return Object.fromEntries(vector);
}

export function unpackVector(packed: Record<string, string>): Vector {
  return new Map(Object.entries(packed));
}

/** Which origins a set of stamps came from, for a vector built out of a stream. */
export function originsOf(stamps: Iterable<string>): Set<string> {
  const origins = new Set<string>();
  for (const stamp of stamps) origins.add(stampPeer(stamp));
  return origins;
}

/** Whether a stamp is work the holder of this vector still lacks. */
export function lacks(vector: Vector, stamp: string): boolean {
  const held = vector.get(stampPeer(stamp));
  return held == null || stamp > held;
}

/** The lowest stamp any origin in the vector is covered to, or '' where one is missing. */
export function floor(vector: Vector, origins: Iterable<string>): string {
  let lowest: string | null = null;
  for (const origin of origins) {
    const held = vector.get(origin) ?? '';
    if (lowest == null || held < lowest) lowest = held;
  }
  return lowest ?? '';
}

/**
 * Remembers what a peer told us it holds, which is what tombstone GC is bounded by.
 *
 * Only for a peer this library is still paired with. A session takes minutes and
 * nothing cancels one when the person presses Forget, so the close would otherwise
 * write the row `forgetPairedPeer` had just deleted - and that peer is then on the
 * GC floor while `reachablePeers` no longer offers it, so its vector can never move
 * again and no grave minted afterwards is ever collectable. Unclearable, too:
 * forgetting it a second time answers "not found". A row that arrives late for a
 * peer that has gone is a row about nobody.
 */
export function recordPeer(db: Database, libraryId: string, peer: string, vector: Vector): void {
  const paired = db
    .query('SELECT 1 FROM replication_peers WHERE library_id = ? AND peer_id = ?')
    .get(libraryId, peer);
  if (paired == null) return;
  const write = db.query(
    `INSERT INTO replication_peer_vectors (library_id, peer_id, origin, stamp) VALUES (?, ?, ?, ?)
     ON CONFLICT (library_id, peer_id, origin) DO UPDATE SET stamp = excluded.stamp
       WHERE excluded.stamp > replication_peer_vectors.stamp`,
  );
  for (const [origin, stamp] of vector) write.run(libraryId, peer, origin, stamp);
}

export function peerVectors(db: Database, libraryId: string): Map<string, Vector> {
  const rows = db
    .query('SELECT peer_id, origin, stamp FROM replication_peer_vectors WHERE library_id = ?')
    .all(libraryId) as { peer_id: string; origin: string; stamp: string }[];
  const peers = new Map<string, Vector>();
  for (const row of rows) {
    const vector = peers.get(row.peer_id) ?? new Map<string, string>();
    vector.set(row.origin, row.stamp);
    peers.set(row.peer_id, vector);
  }
  return peers;
}

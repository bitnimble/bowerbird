import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import type { AllPeersResponse, PairedPeer } from '../../schemas/replication';
import type { BlobLocations } from '../blobs/blob_locations';
import { forgetPeer } from './gc';
import { stamp } from './stamps';
import { replicates } from './tombstones';
import { REPLICATED_UNITS } from './units';

// What pairing leaves behind (docs/replication.md §6.5): the paired-peer rows
// every replication request is checked against, and the library's entry into
// the replicated world. An interlock against pairing the wrong library, not
// authentication (§11.1).

/**
 * Makes a library one this catalogue replicates.
 *
 * This is what settles a catalogue that predates replication (§4): every unit
 * still unstamped gets one genesis stamp, and because the UPDATE names the
 * stamp columns it fires the log trigger for every row it touches - so the log
 * is built from the stamp columns, already-stamped rows included, whose writes
 * happened while the trigger was refusing to log this library.
 */
export function linkLibrary(db: Database, libraryId: string, syncOriginals = true): void {
  db.transaction(() => {
    if (replicates(db, libraryId)) return;
    db.query('INSERT INTO replication_libraries (library_id, sync_originals) VALUES (?, ?)').run(
      libraryId,
      syncOriginals ? 1 : 0,
    );

    const genesis = stamp(db);

    // The develop settings this library's renders were built from, for the edits
    // that are about to be given stamps below. Staleness is that stamp held against
    // what each variant recorded, so without this every photograph developed before
    // pairing reads as owing a render the moment it is paired - the whole library
    // re-rendered to reproduce files that are already correct, and a 404 to every
    // peer asking for one until each lands.
    //
    // `e.stamp IS NULL` is the whole of the population, and the reason this is here
    // rather than anywhere later: an edit that already has a stamp is one this build
    // wrote, whose render recorded what it was built from or is genuinely owed one.
    // A null `built_from` beside a written `built_at` is *the* record that a rebuild
    // is owed - the flags were cleared when the render landed - and the wall clocks
    // cannot tell that apart from a render that included the edit, because
    // `built_at` is written after a render and the settings are read before it. So
    // an edit saved while a render was running looks, to a clock, exactly like one
    // the render contains. Only the edits with no stamp at all are safe to answer
    // for, and `genesis` is the right answer for them because the walk below is
    // about to give them precisely that.
    // Only where the row records when it was built, which is per variant and so is
    // evidence about that variant alone. A copy written at a moment nothing recorded -
    // and `max` was, before it had a row of its own - is left unstamped, which reads as
    // owed: vouching for it off a neighbour's build time is the cross-variant claim the
    // per-variant rows exist to make impossible.
    db.query(
      `UPDATE renditions SET built_from = ?
        WHERE built_from IS NULL AND built_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM photos p JOIN photo_edits e ON e.photo_id = p.id
                       WHERE p.id = renditions.photo_id AND p.library_id = ?
                         AND e.stamp IS NULL AND e.updated_at <= renditions.built_at)`,
    ).run(genesis, libraryId);

    const byTable = new Map<string, typeof REPLICATED_UNITS>();
    for (const unit of REPLICATED_UNITS) {
      byTable.set(unit.table, [...(byTable.get(unit.table) ?? []), unit]);
    }
    for (const units of byTable.values()) {
      const sets = units.map((unit) => `${unit.stamp} = COALESCE(${unit.stamp}, ?)`).join(', ');
      // The unit's library expression with `$.` dropped resolves against the row
      // being updated, exactly as the trigger's NEW-qualified form does.
      const scope = units[0]!.library.replaceAll('$.', '');
      db.query(`UPDATE ${units[0]!.table} SET ${sets} WHERE ${scope} = ?`).run(
        ...units.map(() => genesis),
        libraryId,
      );
    }
  })();
}

/**
 * @param address where this peer can be reached, on the side that has to reach
 * it. Absent for a peer that dialled *us*: it is behind whatever NAT it is behind
 * and we never call it back (§6.4).
 */
export function registerPeer(
  db: Database,
  libraryId: string,
  peerId: string,
  name: string,
  address?: string,
): void {
  db.query(
    `INSERT INTO replication_peers (library_id, peer_id, name, paired_at, address) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (library_id, peer_id) DO UPDATE SET name = excluded.name,
       -- Kept when the new row carries none, so a peer dialling in does not erase
       -- the address we reach it on.
       address = COALESCE(excluded.address, replication_peers.address)`,
  ).run(libraryId, peerId, name, new Date().toISOString(), address ?? null);
}

/** Whether this device keeps the RAW files of a library it replicates (§7.10). */
export function syncsOriginals(db: Database, libraryId: string): boolean {
  const row = db
    .query('SELECT sync_originals FROM replication_libraries WHERE library_id = ?')
    .get(libraryId) as { sync_originals: number } | null;
  // A library that does not replicate keeps its own originals by definition:
  // there is nowhere else for them to be.
  return row == null || row.sync_originals !== 0;
}

export function setSyncsOriginals(db: Database, libraryId: string, value: boolean): void {
  const changed = db
    .query('UPDATE replication_libraries SET sync_originals = ? WHERE library_id = ?')
    .run(value ? 1 : 0, libraryId).changes;
  if (changed === 0) throw new AppError('NOT_FOUND', `library ${libraryId} is not replicated`);
}

/**
 * What a peer said about its own disk at the last handshake (§7.10), so this
 * side can stop offering to send bytes it would refuse. Advisory only: the
 * refusal that counts is the receiving peer's, at the moment they arrive.
 */
export function recordPeerAppetite(db: Database, libraryId: string, peerId: string, wants: boolean): void {
  db.query('UPDATE replication_peers SET wants_originals = ? WHERE library_id = ? AND peer_id = ?').run(
    wants ? 1 : 0,
    libraryId,
    peerId,
  );
}

/** Where to reach a peer, or null for one that only ever dials us. */
export function peerAddress(db: Database, libraryId: string, peerId: string): string | null {
  const row = db
    .query('SELECT address FROM replication_peers WHERE library_id = ? AND peer_id = ?')
    .get(libraryId, peerId) as { address: string | null } | null;
  return row?.address ?? null;
}

/** Every peer of this library that can be dialled, which is what a sync run walks. */
export function reachablePeers(db: Database, libraryId: string): { peerId: string; address: string }[] {
  return (
    db
      .query(
        'SELECT peer_id, address FROM replication_peers WHERE library_id = ? AND address IS NOT NULL ORDER BY paired_at',
      )
      .all(libraryId) as { peer_id: string; address: string }[]
  ).map((row) => ({ peerId: row.peer_id, address: row.address }));
}

/** Refuses a request from a peer this library was never paired with (§6.5, §11.2). */
export function assertPaired(db: Database, libraryId: string, peerId: string): void {
  const paired = db
    .query('SELECT 1 FROM replication_peers WHERE library_id = ? AND peer_id = ?')
    .get(libraryId, peerId);
  if (paired == null) {
    throw new AppError('NOT_FOUND', `peer ${peerId} is not paired with library ${libraryId}`);
  }
}

export function pairedPeers(db: Database, libraryId: string): PairedPeer[] {
  const rows = db
    .query(
      `SELECT peer_id, name, paired_at, last_replicated_at, last_error, wants_originals FROM replication_peers
        WHERE library_id = ? ORDER BY paired_at, peer_id`,
    )
    .all(libraryId) as (Omit<PairedPeer, 'wants_originals'> & { wants_originals: number })[];
  return rows.map((row) => ({ ...row, wants_originals: row.wants_originals !== 0 }));
}

/**
 * Every library that replicates, with its peers and its appetite for originals.
 *
 * A library absent from this replicates with nobody, which is the answer a page
 * needs about most of them: the sidebar, the strips and the badges are all gated on
 * having a peer (§10), and asking per library is one request each to be told no.
 */
export function everyPairing(db: Database): AllPeersResponse['libraries'] {
  const rows = db
    .query('SELECT library_id, sync_originals FROM replication_libraries ORDER BY library_id')
    .all() as { library_id: string; sync_originals: number }[];
  return rows.map((row) => ({
    library_id: row.library_id,
    peers: pairedPeers(db, row.library_id),
    sync_originals: row.sync_originals !== 0,
  }));
}

/** What went wrong last time, or null once a session gets through (§8.6). */
export function recordPeerOutcome(db: Database, libraryId: string, peerId: string, error: string | null): void {
  db.query('UPDATE replication_peers SET last_error = ? WHERE library_id = ? AND peer_id = ?').run(
    error,
    libraryId,
    peerId,
  );
}

export function renamePeer(db: Database, libraryId: string, peerId: string, name: string): void {
  const changed = db
    .query('UPDATE replication_peers SET name = ? WHERE library_id = ? AND peer_id = ?')
    .run(name, libraryId, peerId).changes;
  if (changed === 0) throw new AppError('NOT_FOUND', `peer ${peerId} is not paired with library ${libraryId}`);
}

/**
 * The user-facing forget (§6.5, §8.4): the peer stops bounding tombstone
 * collection, and if it ever returns it is refused and re-pairs fresh, arriving
 * as a clone.
 */
export function forgetPairedPeer(db: Database, libraryId: string, peerId: string, locations: BlobLocations): void {
  db.transaction(() => {
    const removed = db
      .query('DELETE FROM replication_peers WHERE library_id = ? AND peer_id = ?')
      .run(libraryId, peerId).changes;
    if (removed === 0) {
      throw new AppError('NOT_FOUND', `peer ${peerId} is not paired with library ${libraryId}`);
    }
    forgetPeer(db, libraryId, peerId);
    // Its claims on the originals go with it, and this is the last chance: it is
    // refused if it ever returns, so nothing else can ever retract them (§8.4).
    locations.forgetPeer(libraryId, peerId);
  })();
}

export function markReplicated(db: Database, libraryId: string, peerId: string): void {
  db.query('UPDATE replication_peers SET last_replicated_at = ? WHERE library_id = ? AND peer_id = ?').run(
    new Date().toISOString(),
    libraryId,
    peerId,
  );
}

export function deviceName(db: Database): string {
  const identity = db.query('SELECT name FROM replication_identity WHERE singleton = 1').get() as {
    name: string;
  };
  return identity.name;
}

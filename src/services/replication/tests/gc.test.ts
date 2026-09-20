// Tombstone GC, bounded by acknowledgement rather than by age
// (docs/replication.md §8.3). What these pin is that a grave outlives every
// peer that has not been told about it, and that reaping one can never bring
// the row back on a peer that already applied it.
import { describe, expect, it } from 'bun:test';
import type { Database } from '../../../db/driver';
import { BlobLocations } from '../../blobs/blob_locations';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { collectTombstones, forgetPeer, peersHoldingUpCollection } from '../gc';
import { forgetPairedPeer, registerPeer } from '../pairing';
import { pull, replicate } from '../session';
import { peerId, stamp } from '../stamps';
import { differences, LIB, makePeer, type Peer } from './peers';

const PHOTOS = ['p1', 'p2', 'p3'];

function seed(peer: Peer): void {
  const insert = peer.db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, stamp_imported)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
  );
  for (const id of PHOTOS) insert.run(id, LIB, `${id}.arw`, stamp(peer.db));
}

// A session only ever runs between peers that are paired: the inbound half checks
// it and the outbound half draws its peers from the pairing table. What a peer
// holds is only worth remembering while that is true - a vector for one that has
// gone is a vector nothing can ever move again.
function paired(server: Peer, ...others: Peer[]): void {
  for (const other of others) registerPeer(server.db, LIB, peerId(other.db), 'peer');
}

function grave(db: Database, rowId: string): { stamp: string } | null {
  return db
    .query(
      "SELECT stamp FROM replication_log WHERE library_id = ? AND entity = 'photo' AND row_id = ? AND deleted = 1",
    )
    .get(LIB, rowId) as { stamp: string } | null;
}

describe('tombstone GC', () => {
  it('keeps a grave while any known peer has not acknowledged it', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    const desktop = makePeer('desktop');
    paired(server, laptop, desktop);
    replicate(laptop, server);
    replicate(desktop, server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    replicate(laptop, server);

    expect(collectTombstones(server.db, LIB)).toBe(0);
    expect(grave(server.db, 'p1')).not.toBeNull();
    expect(peersHoldingUpCollection(server.db, LIB)).toEqual([peerId(desktop.db)]);
  });

  it('reaps a grave once every known peer has passed it', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    const desktop = makePeer('desktop');
    replicate(laptop, server);
    replicate(desktop, server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    replicate(laptop, server);
    replicate(desktop, server);

    expect(collectTombstones(server.db, LIB)).toBe(1);
    expect(grave(server.db, 'p1')).toBeNull();
    expect(peersHoldingUpCollection(server.db, LIB)).toEqual([]);
  });

  it('is blocked entirely by a peer that never replicated this origin', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    // The phone was heard from exactly once, before it had pulled anything: known,
    // with a vector that covers none of the server's work.
    const phone = makePeer('phone');
    paired(server, laptop, phone);
    phone.db.query('UPDATE libraries SET name = ?, stamp = ? WHERE id = ?').run('Phone trip', stamp(phone.db), LIB);
    pull(server, phone);
    replicate(laptop, server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    replicate(laptop, server);

    expect(collectTombstones(server.db, LIB)).toBe(0);
    expect(grave(server.db, 'p1')).not.toBeNull();
    expect(peersHoldingUpCollection(server.db, LIB)).toEqual([peerId(phone.db)]);
  });

  it('collects once the peer holding everything up is forgotten', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    const phone = makePeer('phone');
    phone.db.query('UPDATE libraries SET name = ?, stamp = ? WHERE id = ?').run('Phone trip', stamp(phone.db), LIB);
    pull(server, phone);
    replicate(laptop, server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    replicate(laptop, server);
    forgetPeer(server.db, LIB, peerId(phone.db));

    expect(collectTombstones(server.db, LIB)).toBe(1);
    expect(grave(server.db, 'p1')).toBeNull();
    expect(peersHoldingUpCollection(server.db, LIB)).toEqual([]);
  });

  /**
   * A session takes minutes and nothing cancels one when Forget is pressed.
   *
   * So the close lands after the peer has gone, and re-creates the vector row that
   * `forgetPairedPeer` had just deleted. That peer is then back on the GC floor
   * while nothing offers it as reachable any more, so its vector can never move
   * again and no grave minted afterwards is ever collected - and forgetting it a
   * second time answers "not found", so there is no way out of it either.
   */
  it('does not take a vector from a session that closed after the peer was forgotten', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    paired(server, laptop);

    forgetPairedPeer(server.db, LIB, peerId(laptop.db), new BlobLocations(server.db));
    // The session that was already running finishes and says what it took.
    replicate(laptop, server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);

    expect(peersHoldingUpCollection(server.db, LIB)).toEqual([]);
    expect(collectTombstones(server.db, LIB)).toBe(1);
  });

  it('retracts a forgotten peer\'s claims on the originals, and says what only it holds', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    replicate(laptop, server);
    const locations = new BlobLocations(server.db);
    const departing = peerId(laptop.db);
    registerPeer(server.db, LIB, departing, 'Laptop');
    // As replication would have landed them: the laptop holds p1 and p2, and the
    // server holds p2 as well.
    for (const photo of ['p1', 'p2']) {
      server.db
        .query('INSERT INTO blob_locations (library_id, photo_id, peer_id, stamp) VALUES (?, ?, ?, ?)')
        .run(LIB, photo, departing, stamp(server.db));
    }
    locations.record(LIB, 'p2');

    // Only p1 would go out of reach; p2 is here too.
    expect(locations.soleHoldings(LIB, departing)).toEqual(['p1']);

    forgetPairedPeer(server.db, LIB, departing, locations);

    expect(locations.holders(LIB, 'p1')).toEqual([]);
    expect(locations.holders(LIB, 'p2')).toEqual([peerId(server.db)]);
    // Tombstoned rather than merely dropped: every other peer has to hear that
    // the claim is gone, and the departing peer can never say so itself.
    const retracted = server.db
      .query(
        "SELECT row_id FROM replication_log WHERE library_id = ? AND entity = 'blob_location' AND deleted = 1 ORDER BY row_id",
      )
      .all(LIB) as { row_id: string }[];
    expect(retracted.map((row) => row.row_id)).toEqual([`p1/${departing}`, `p2/${departing}`]);
  });

  it('does not resurrect a reaped deletion on a peer that already applied it', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');
    replicate(laptop, server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    replicate(laptop, server);

    expect(collectTombstones(server.db, LIB)).toBe(1);
    expect(collectTombstones(laptop.db, LIB)).toBe(1);

    replicate(laptop, server);
    replicate(server, laptop);

    expect(server.db.query('SELECT 1 FROM photos WHERE id = ?').get('p1')).toBeNull();
    expect(laptop.db.query('SELECT 1 FROM photos WHERE id = ?').get('p1')).toBeNull();
    expect(grave(server.db, 'p1')).toBeNull();
    expect(grave(laptop.db, 'p1')).toBeNull();
    expect(differences(server, laptop)).toEqual([]);
  });

  it('reaps with no peers recorded, since a later peer can only arrive as a fresh clone', () => {
    const server = makePeer('server');
    seed(server);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);

    expect(collectTombstones(server.db, LIB)).toBe(1);
    expect(grave(server.db, 'p1')).toBeNull();
  });
});

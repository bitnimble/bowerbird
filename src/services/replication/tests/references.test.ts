import { describe, expect, it } from 'bun:test';
import { ShootsRepository } from '../../shoots/shoots_repository';
import { pull, replicate } from '../session';
import { peerId, stamp } from '../stamps';
import { LIB, makePeer, type Peer } from './peers';

// What a peer does with a reference it cannot honour yet (docs/replication.md §5.1).
//
// A page is stamp-ordered and only the page is sorted parents-first, so a shoot
// written after its photographs were placed is a *later* page than they are. The
// difference between "not here yet" and "deleted here" is the difference between a
// membership that arrives late and one that is destroyed.

function shoot(peer: Peer, id: string, folder: string): void {
  peer.db
    .query('INSERT INTO shoots (id, library_id, name, folder_path, stamp) VALUES (?, ?, ?, ?, ?)')
    .run(id, LIB, folder, folder, stamp(peer.db));
}

function photo(peer: Peer, id: string, shootId: string | null): void {
  peer.db
    .query(
      `INSERT INTO photos (id, library_id, shoot_id, recipe, width, height, date_added, stamp_imported, stamp_placement)
         VALUES (?, ?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(id, LIB, shootId, `${id}.arw`, stamp(peer.db), stamp(peer.db));
}

function shootOf(peer: Peer, photoId: string): string | null {
  return (peer.db.query('SELECT shoot_id FROM photos WHERE id = ?').get(photoId) as { shoot_id: string | null })
    .shoot_id;
}

describe('a photograph arriving before its shoot', () => {
  /**
   * The one that matters: a page at a time, the photograph lands first.
   *
   * Nulling its `shoot_id` on the grounds that the shoot is not here writes a row
   * that succeeds, so the stamp is claimed - and the shoot arriving in the next
   * page has nothing left to attach. Every photograph of a shoot renamed after its
   * import loses its shoot on the clone, for good, and the shoot then reads as
   * empty to the scan's mirroring, which deletes it and tombstones it to the fleet.
   */
  it('is never landed stripped of a shoot that is merely later in the stream', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'Day1');
    photo(server, 'p1', 's1');
    // A rename, so the shoot's stamp is above the photograph's and it pages last.
    server.advance();
    new ShootsRepository(server.db).updateFields('s1', { name: 'Iceland' });

    pull(laptop, server, 1);

    // Waiting is the right answer and losing the membership is not, so what this
    // forbids is the row being *here* with its shoot gone - the state no later
    // session repairs, because the write succeeded and the stamp was claimed.
    expect(laptop.db.query('SELECT COUNT(*) AS n FROM photos WHERE shoot_id IS NULL').get()).toEqual({ n: 0 });
  });

  it('gets there in the end, over as many sessions as it takes', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'Day1');
    photo(server, 'p1', 's1');
    server.advance();
    new ShootsRepository(server.db).updateFields('s1', { name: 'Iceland' });

    pull(laptop, server, 1);
    replicate(server, laptop);

    expect(shootOf(laptop, 'p1')).toBe('s1');
    expect(laptop.db.query('SELECT name FROM shoots WHERE id = ?').get('s1')).toEqual({ name: 'Iceland' });
  });

  // The case the resolution exists for, which is not the one above: this peer has
  // the shoot's grave, so it knows the membership is over rather than pending, and
  // answers exactly as its own copy of that deletion answered for every other
  // photograph in it.
  it('belongs to no shoot when this peer has buried that shoot', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'Day1');
    photo(server, 'p1', 's1');
    replicate(server, laptop);
    new ShootsRepository(laptop.db).delete('s1');

    // The server has not heard, and goes on describing the photograph as a member.
    server.advance();
    server.db.query('UPDATE photos SET rating = 4, stamp_triage = ? WHERE id = ?').run(stamp(server.db), 'p1');
    pull(laptop, server);

    expect(shootOf(laptop, 'p1')).toBeNull();
    expect(laptop.db.query('SELECT rating FROM photos WHERE id = ?').get('p1')).toEqual({ rating: 4 });
  });

  /**
   * A deferral costs the gap, not the origin.
   *
   * The vector says "everything this origin wrote up to here is applied", so an
   * origin something was deferred from cannot be claimed to its newest. Dropping
   * it altogether claims *nothing* from it, and the sender's next scan then
   * restarts at the bottom of its log and re-streams every change that origin
   * ever made - which for a first clone is the whole library, twice.
   */
  it('leaves the origin covered up to the change it could not take', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'Day1');
    photo(server, 'p1', 's1');
    server.advance();
    new ShootsRepository(server.db).updateFields('s1', { name: 'Iceland' });
    server.advance();
    photo(server, 'p2', null);

    pull(laptop, server, 1);

    // Covered, and stopping below the deferred photograph rather than at nothing.
    // Named by origin, since a vector holds one entry per peer that ever wrote.
    const held = server.db.query('SELECT stamp_placement AS at FROM photos WHERE id = ?').get('p1') as { at: string };
    const covered = laptop.db
      .query('SELECT stamp FROM replication_vectors WHERE library_id = ? AND origin = ?')
      .get(LIB, peerId(server.db)) as { stamp: string } | null;
    expect(covered).not.toBeNull();
    expect(covered!.stamp < held.at).toBe(true);
  });

  /**
   * A row carries a stamp per unit, and holding back the newest of them holds back
   * the wrong origin.
   *
   * A photograph placed by one peer and rated by another is one change carrying two
   * origins' stamps. If the rating is the newer, that is the stamp the change
   * reports - so a deferral that caps on it caps the *rater*, while the peer whose
   * placement is missing is claimed in full and never sends it again. When the rater
   * is this peer itself the cap is not even applied, a vector never taking a
   * remote's word about its own origin. The membership is then gone for good, and
   * every later session agrees it is up to date.
   */
  it('holds back every origin whose unit it could not take, not just the newest', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    photo(server, 'p1', null);
    replicate(server, laptop);

    shoot(server, 's1', 'Day1');
    server.advance();
    server.db.query('UPDATE photos SET shoot_id = ?, stamp_placement = ? WHERE id = ?').run('s1', stamp(server.db), 'p1');
    // Newer, and minted here, so it is the stamp the whole change reports.
    laptop.advance();
    laptop.db.query('UPDATE photos SET rating = 4, stamp_triage = ? WHERE id = ?').run(stamp(laptop.db), 'p1');
    pull(server, laptop);
    // The shoot pages last, so the placement arrives before it.
    server.advance();
    new ShootsRepository(server.db).updateFields('s1', { name: 'Iceland' });

    pull(laptop, server, 1);
    replicate(server, laptop);
    replicate(server, laptop);

    expect(shootOf(laptop, 'p1')).toBe('s1');
    expect(laptop.db.query('SELECT rating FROM photos WHERE id = ?').get('p1')).toEqual({ rating: 4 });
  });

  // A deferral is not a drop: the page's other changes still land, and the stamp is
  // left unclaimed so the change comes back rather than going missing between two
  // peers that both think they are in step.
  it('does not hold up the rest of its page, nor go missing itself', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    shoot(server, 's1', 'Day1');
    photo(server, 'p1', 's1');
    photo(server, 'p2', null);
    server.advance();
    new ShootsRepository(server.db).updateFields('s1', { name: 'Iceland' });

    pull(laptop, server, 2);

    expect(laptop.db.query('SELECT id FROM photos').all()).toEqual([{ id: 'p2' }]);

    // Unclaimed, so it comes back rather than being lost between two peers that
    // both think they are in step.
    replicate(server, laptop);
    expect(shootOf(laptop, 'p1')).toBe('s1');
  });
});

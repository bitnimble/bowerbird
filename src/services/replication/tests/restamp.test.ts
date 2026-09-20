import { describe, expect, it } from 'bun:test';
import { PhotoStateRepository } from '../../photos/mutations/photo_state_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { newestStamp, restampRestored } from '../restamp';
import { replicate } from '../session';
import { stamp } from '../stamps';
import { LIB, makePeer, type Peer } from './peers';

// Restoring a backup onto a peer that replicates (docs/replication.md §8.2).

function seed(peer: Peer): void {
  peer.db
    .query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added, stamp_imported)
         VALUES ('p1', ?, '{"kind":"file","path":"p1.arw"}', 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(LIB, stamp(peer.db));
}

describe('a restored catalogue', () => {
  it('keeps what was restored: the peers take it rather than handing back the newer state', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    new PhotoStateRepository(server.db, new StackMembership(server.db)).update('p1', { rating: 5 });
    replicate(server, laptop);

    // The week that is being rolled back: work landed everywhere, and the laptop
    // still holds it after the server is restored to before it.
    server.advance();
    new PhotoStateRepository(server.db, new StackMembership(server.db)).update('p1', { rating: 1, notes: 'a bulk edit that went wrong' });
    replicate(server, laptop);
    const floor = newestStamp(server.db);

    // The restore itself, modelled as the catalogue going back to what it held:
    // the rows are the backup's, and their stamps are the backup's too.
    const restored = makePeer('restored');
    seed(restored);
    new PhotoStateRepository(restored.db, new StackMembership(restored.db)).update('p1', { rating: 5 });

    expect(restampRestored(restored.db, floor)).toBeGreaterThan(0);
    replicate(restored, laptop);

    for (const peer of [restored, laptop]) {
      expect(peer.db.query('SELECT rating, notes FROM photos WHERE id = ?').get('p1')).toEqual({
        rating: 5,
        notes: null,
      });
    }
  });

  it('is undone by the first session when it is not re-stamped, which is what this exists to stop', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    new PhotoStateRepository(server.db, new StackMembership(server.db)).update('p1', { rating: 5 });
    replicate(server, laptop);
    server.advance();
    new PhotoStateRepository(server.db, new StackMembership(server.db)).update('p1', { rating: 1 });
    replicate(server, laptop);

    const restored = makePeer('restored');
    seed(restored);
    new PhotoStateRepository(restored.db, new StackMembership(restored.db)).update('p1', { rating: 5 });
    replicate(restored, laptop);

    expect(restored.db.query('SELECT rating FROM photos WHERE id = ?').get('p1')).toEqual({ rating: 1 });
  });

  it('does not throw away what the peers have imported since the backup', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    laptop.advance();
    laptop.db
      .query(
        `INSERT INTO photos (id, library_id, recipe, width, height, date_added, stamp_imported)
           VALUES ('p2', ?, '{"kind":"file","path":"p2.arw"}', 100, 100, '2026-02-01T00:00:00.000Z', ?)`,
      )
      .run(LIB, stamp(laptop.db));

    const restored = makePeer('restored');
    seed(restored);
    restampRestored(restored.db, newestStamp(laptop.db));
    replicate(restored, laptop);

    // The restore is a statement about the values it holds, not a claim that
    // nothing has happened since.
    expect(restored.db.query('SELECT COUNT(*) AS n FROM photos').get()).toEqual({ n: 2 });
  });

  it('leaves a catalogue that replicates with nobody alone', () => {
    const alone = makePeer('alone');
    alone.db.query('DELETE FROM replication_libraries').run();
    seed(alone);

    expect(restampRestored(alone.db, null)).toBe(0);
  });
});

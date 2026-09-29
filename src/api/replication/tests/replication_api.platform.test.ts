import { afterEach, describe, expect, it } from 'bun:test';
import { PhotoStateRepository } from '../../../services/photos/mutations/photo_state_repository';
import { StackMembership } from '../../../services/stacks/stack_membership';
import { pullFromRemote, pushToRemote } from '../../../services/replication/remote';
import { replicatedState } from '../../../services/replication/tests/peers';
import { cleanUp, pairedClone, peerIdOf } from './replication_api_test_helpers';

afterEach(cleanUp);

describe('clone (§9)', () => {
  it('brings a fresh replica to exactly what the origin holds, ids verbatim, over the ordinary stream', async () => {
    const { origin, clone } = await pairedClone();

    const pulled = await pullFromRemote(clone.replica, origin.url);
    expect(pulled.applied).toBeGreaterThan(0);
    expect(pulled.deferred).toBe(0);

    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
    const ids = clone.db.query('SELECT id FROM photos ORDER BY id').all() as { id: string }[];
    expect(ids.map((row) => row.id)).toEqual(['p1', 'p2', 'p3']);

    // Nothing left to say: a second session finds the vector already covers it.
    const again = await pullFromRemote(clone.replica, origin.url);
    expect(again.applied).toBe(0);
  });
});

describe('sessions over HTTP (§6.2)', () => {
  // The trip, and the whole point of the feature: only the laptop can dial, so if
  // dialling did not also *offer*, a fortnight of work would stay on the laptop.
  it('carries the dialling peer\'s own work to a peer that can never dial back', async () => {
    const { origin, clone } = await pairedClone();
    await pullFromRemote(clone.replica, origin.url);

    // The origin knows no address for the clone - a laptop is behind whatever
    // network it is on - so it can never start a session of its own.
    expect(
      origin.db.query('SELECT address FROM replication_peers WHERE peer_id = ?').get(peerIdOf(clone.db)),
    ).toEqual({ address: null });

    new PhotoStateRepository(clone.db, new StackMembership(clone.db)).update('p2', { rating: 4, notes: 'shot on the trip' });
    const given = await pushToRemote(clone.replica, origin.url);

    expect(given.applied).toBeGreaterThan(0);
    expect(origin.db.query('SELECT rating, notes FROM photos WHERE id = ?').get('p2')).toEqual({
      rating: 4,
      notes: 'shot on the trip',
    });
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));

    // And the origin has taken coverage of it, so it does not ask again.
    const again = await pushToRemote(clone.replica, origin.url);
    expect(again.applied).toBe(0);
  });
});

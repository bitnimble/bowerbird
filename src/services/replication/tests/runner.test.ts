// What a run owes beyond its sessions (docs/replication.md §6.4, §8.3). The peer
// everyone else dials - the server - reaches nobody, so a run there has no session
// to make at all, and the close-out is the whole of what it does.
import { expect, it } from 'bun:test';
import { BlobLocations } from '../../blobs/blob_locations';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { SyncLocksRepository } from '../../sync/coordination/sync_locks_repository';
import { registerPeer } from '../pairing';
import { ReplicationRunner } from '../replication_runner';
import { replicate } from '../session';
import { peerId, stamp } from '../stamps';
import { LIB, makePeer, type Peer } from './peers';

function runnerFor(peer: Peer): ReplicationRunner {
  return new ReplicationRunner(
    peer.db,
    new SyncLocksRepository(peer.db),
    new LibrariesRepository(peer.db),
    new BlobLocations(peer.db),
    () => {},
    () => {},
    () => {},
    () => Promise.resolve(0),
  );
}

function graves(peer: Peer): number {
  const row = peer.db
    .query("SELECT COUNT(*) AS n FROM replication_log WHERE library_id = ? AND entity = 'photo' AND deleted = 1")
    .get(LIB) as { n: number };
  return row.n;
}

it('sweeps on a peer that dials nobody, which is the only run the server ever makes', async () => {
  const server = makePeer('server');
  const laptop = makePeer('laptop');
  server.db
    .query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added, stamp_imported)
         VALUES ('p1', ?, '{"kind":"file","path":"p1.arw"}', 100, 100, '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(LIB, stamp(server.db));
  // Paired without an address, as a peer that only ever gets dialled is (§6.4):
  // this is what makes the server's own run find nothing to talk to.
  registerPeer(server.db, LIB, peerId(laptop.db), 'laptop');
  replicate(laptop, server);

  server.advance();
  new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
  // The laptop hears about it and says so, which is what lets the grave go.
  replicate(laptop, server);
  expect(graves(server)).toBe(1);

  const result = await runnerFor(server).replicate(LIB);

  expect(result).toEqual({ applied: 0, peers: 0 });
  // Without the sweep the server's log grows for as long as it is a server.
  expect(graves(server)).toBe(0);
});

// Every write to a library's peers is news to a window that did not make it
// (docs/replication.md §8.6, §10). Nothing on this device polls for it, so a
// mutation that announces nothing is one no other page ever learns of.
import { expect, it } from 'bun:test';
import { BlobLocations } from '../../blobs/blob_locations';
import { registerPeer } from '../pairing';
import { ReplicationService } from '../replication_service';
import { LIB, makePeer } from './peers';

const PEER = 'peer000000000001';

function serviceThatRecords(): { service: ReplicationService; announced: string[] } {
  const peer = makePeer('desktop');
  registerPeer(peer.db, LIB, PEER, 'Macbook');
  const announced: string[] = [];
  const service = new ReplicationService(
    peer.db,
    new BlobLocations(peer.db),
    Date.now,
    () => {},
    (libraryId) => announced.push(libraryId),
  );
  return { service, announced };
}

it('announces a local rename, a forget, and a change of what this device keeps', () => {
  const { service, announced } = serviceThatRecords();

  service.setSyncsOriginals(LIB, false);
  service.renamePeer(LIB, PEER, 'Laptop');
  service.forgetPeer(LIB, PEER);

  expect(announced).toEqual([LIB, LIB, LIB]);
});

it('announces a pairing made from the other end', () => {
  const { service, announced } = serviceThatRecords();

  service.pair({ library_id: LIB, peer_id: 'peer000000000002', name: 'Phone' });

  expect(announced).toEqual([LIB]);
});

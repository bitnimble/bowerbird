import {
  AddReplicaRequestSchema,
  type AllPeersResponse,
  AllPeersResponseSchema,
  type BrowsedRemote,
  BrowsedRemoteSchema,
  BrowseRemoteRequestSchema,
  type PeersResponse,
  PeersResponseSchema,
  type ReachableAddress,
  ReachableAddressesSchema,
  RenamePeerRequestSchema,
  type ReplicaSummary,
  ReplicaSummarySchema,
  ReplicateResultSchema,
  SoleHoldingsResponseSchema,
  SyncOriginalsRequestSchema,
  SyncOriginalsResponseSchema,
} from '../../../src/schemas/replication';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

export const replicationApi = {
  // Replication (docs/replication.md §6.5, §10): the peers a synced library
  // replicates with, and what this device keeps of it.
  listPeers: (libraryId: string): Promise<PeersResponse> =>
    request(
      PeersResponseSchema,
      'GET',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), libraryId, PathSegment.peers()),
    ),
  // The same for the whole install, which is what a page opens with: the gate on
  // every piece of replication UI is "does this library have a peer", and asking
  // it per library is a request each to be told no.
  listAllPeers: (): Promise<AllPeersResponse> =>
    request(AllPeersResponseSchema, 'GET', route(PathSegment.api(), PathSegment.replication(), PathSegment.peers())),
  // §7.10: whether this device keeps this library's RAW files, or lives on the
  // catalogue and the renditions its peers build.
  setSyncOriginals: (libraryId: string, syncOriginals: boolean): Promise<{ cancelled: number }> =>
    request(
      SyncOriginalsResponseSchema,
      'PATCH',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), libraryId, PathSegment.originals()),
      SyncOriginalsRequestSchema.parse({ sync_originals: syncOriginals }),
    ),
  // §9.1: where to tell another device to reach this one.
  reachableAddresses: (): Promise<{ addresses: ReachableAddress[] }> =>
    request(ReachableAddressesSchema, 'GET', route(PathSegment.api(), PathSegment.replication(), PathSegment.reachable())),
  // This device joining somebody else's library (§9.1). Browsing registers
  // nothing on either side; adding is the pairing and the clone, and the whole
  // catalogue arrives before the request answers.
  browseRemote: (address: string): Promise<BrowsedRemote> =>
    request(
      BrowsedRemoteSchema,
      'POST',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.replicas(), PathSegment.browse()),
      BrowseRemoteRequestSchema.parse({ address }),
    ),
  addReplica: (address: string, libraryId: string, rootPath: string, syncOriginals: boolean): Promise<ReplicaSummary> =>
    request(
      ReplicaSummarySchema,
      'POST',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.replicas()),
      AddReplicaRequestSchema.parse({
        address,
        library_id: libraryId,
        root_path: rootPath,
        sync_originals: syncOriginals,
      }),
    ),
  replicate: (libraryId: string): Promise<{ applied: number; peers: number }> =>
    request(
      ReplicateResultSchema,
      'POST',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), libraryId, PathSegment.replicate()),
    ),
  renamePeer: (libraryId: string, peerId: string, name: string): Promise<void> =>
    request(
      NothingSchema,
      'PATCH',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), libraryId, PathSegment.peers(), peerId),
      RenamePeerRequestSchema.parse({ name }),
    ),
  // §8.4: the originals only this peer is recorded as holding, which forgetting
  // it would put out of reach.
  soleHoldings: (libraryId: string, peerId: string): Promise<{ photos: string[] }> =>
    request(
      SoleHoldingsResponseSchema,
      'GET',
      route(
        PathSegment.api(),
        PathSegment.replication(),
        PathSegment.libraries(),
        libraryId,
        PathSegment.peers(),
        peerId,
        PathSegment.soleHoldings(),
      ),
    ),
  forgetPeer: (libraryId: string, peerId: string): Promise<void> =>
    request(
      NothingSchema,
      'DELETE',
      route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), libraryId, PathSegment.peers(), peerId),
    ),
};

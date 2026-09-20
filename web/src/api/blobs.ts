import {
  BlobQueueResponseSchema,
  EvictBlobsRequestSchema,
  type EvictResult,
  EvictResultSchema,
  PushBlobsRequestSchema,
  type Transfer,
  TransferSchema,
  TransfersSchema,
} from '../../../src/schemas/blobs';
import { type PhotoTarget } from '../../../src/schemas/photos';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

export const blobsApi = {
  // Originals moving between peers (§7.3, §7.5): both queue actions are the
  // diff over blob locations, so pressing one again is restart recovery, and
  // "how many were queued" is the answer either gives.
  pushOriginals: (libraryId: string, peerId: string): Promise<{ queued: number }> =>
    request(
      BlobQueueResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.blobs(), PathSegment.push()),
      PushBlobsRequestSchema.parse({ library_id: libraryId, peer_id: peerId, scope: { library: true } }),
    ),
  pullOriginals: (libraryId: string, peerId: string): Promise<{ queued: number }> =>
    request(
      BlobQueueResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.blobs(), PathSegment.pull()),
      PushBlobsRequestSchema.parse({ library_id: libraryId, peer_id: peerId, scope: { library: true } }),
    ),
  listTransfers: (libraryId?: string): Promise<Transfer[]> =>
    request(
      TransfersSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.blobs(), PathSegment.transfers())}${libraryId == null ? '' : `?library_id=${libraryId}`}`,
    ),
  pauseTransfer: (id: string): Promise<void> =>
    request(NothingSchema, 'POST', route(PathSegment.api(), PathSegment.blobs(), PathSegment.transfers(), id, PathSegment.pause())),
  resumeTransfer: (id: string): Promise<void> =>
    request(NothingSchema, 'POST', route(PathSegment.api(), PathSegment.blobs(), PathSegment.transfers(), id, PathSegment.resume())),
  cancelTransfer: (id: string): Promise<void> =>
    request(NothingSchema, 'POST', route(PathSegment.api(), PathSegment.blobs(), PathSegment.transfers(), id, PathSegment.cancel())),
  // §7.5: undefined when the original is already local, the queue entry otherwise.
  fetchOriginal: (photoId: string): Promise<Transfer | undefined> =>
    request(TransferSchema.optional(), 'POST', route(PathSegment.api(), PathSegment.blobs(), photoId, PathSegment.fetch())),
  // §7.6: gives back the disk, keeping the catalogue. The server asks the peer
  // named here whether it really holds the bytes before deleting anything, and
  // refuses per photograph rather than as a batch when it does not.
  evictOriginals: (target: PhotoTarget, peerId: string): Promise<EvictResult> =>
    request(
      EvictResultSchema,
      'POST',
      route(PathSegment.api(), PathSegment.blobs(), PathSegment.evict()),
      EvictBlobsRequestSchema.parse({ target, peer_id: peerId }),
    ),
};

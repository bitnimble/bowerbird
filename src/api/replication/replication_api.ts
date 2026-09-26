import { Hono } from 'hono';
import {
  AckRequestSchema,
  AddReplicaRequestSchema,
  AllPeersResponseSchema,
  BrowseRemoteRequestSchema,
  BrowsedRemoteSchema,
  ChangesRequestSchema,
  HandshakeRequestSchema,
  HandshakeResponseSchema,
  PageSchema,
  PairRequestSchema,
  PairResponseSchema,
  PeersResponseSchema,
  PushDoneRequestSchema,
  PushPageRequestSchema,
  PushPageResponseSchema,
  RemoteLibrariesSchema,
  RenamePeerRequestSchema,
  ReplicaSummarySchema,
  ReplicateResultSchema,
  SoleHoldingsResponseSchema,
  SyncOriginalsRequestSchema,
  SyncOriginalsResponseSchema,
  UnpairRequestSchema,
} from '../../schemas/replication';
import { PathSegment, route } from '../../schemas/route';
import { takeAsLongAsItTakes } from '../long_requests';
import { respond } from '../respond';
import type { ReplicationRunner } from '../../services/replication/replication_runner';
import type { ReplicationService } from '../../services/replication/replication_service';

export class ReplicationApi {
  readonly routes: Hono;

  constructor(
    private readonly replication: ReplicationService,
    private readonly runner: ReplicationRunner,
    /** What is still on its way here, for a device that has stopped wanting it (§7.10). */
    private readonly cancelIncoming: (libraryId: string) => Promise<number> = () => Promise.resolve(0),
  ) {
    const app = new Hono();

    // What this device offers a peer that asks (§9.1): a read, registering
    // nothing, so the dialog on the other device can list them and pick one.
    app.get(route(PathSegment.libraries()), (c) => c.json(respond(RemoteLibrariesSchema, this.replication.offered())));

    app.post(route(PathSegment.pair()), async (c) => {
      return c.json(respond(PairResponseSchema, this.replication.pair(PairRequestSchema.parse(await c.req.json()))));
    });

    app.post(route(PathSegment.handshake()), async (c) => {
      const request = HandshakeRequestSchema.parse(await c.req.json());
      return c.json(respond(HandshakeResponseSchema, this.replication.handshake(request)));
    });

    app.post(route(PathSegment.changes()), async (c) => {
      return c.json(respond(PageSchema, this.replication.changes(ChangesRequestSchema.parse(await c.req.json()))));
    });

    // The other direction (§6.4): what the caller holds and this server lacks.
    // Only the peer that can dial has a way to offer its own work, and on every
    // topology but two servers on one network that is the only peer there is.
    app.post(route(PathSegment.push()), async (c) => {
      const request = PushPageRequestSchema.parse(await c.req.json());
      return c.json(respond(PushPageResponseSchema, await this.replication.receive(request)));
    });

    app.post(route(PathSegment.push(), PathSegment.done()), async (c) => {
      this.replication.finishReceiving(PushDoneRequestSchema.parse(await c.req.json()));
      return c.body(null, 204);
    });

    app.post(route(PathSegment.ack()), async (c) => {
      this.replication.ack(AckRequestSchema.parse(await c.req.json()));
      return c.body(null, 204);
    });

    // A peer saying to forget it, which is also how a half-made pairing is rolled
    // back when the local half fails (§8.4, §9.1).
    app.post(route(PathSegment.unpair()), async (c) => {
      this.replication.unpair(UnpairRequestSchema.parse(await c.req.json()));
      return c.body(null, 204);
    });

    // Joining somebody else's library, in two parts (§9.1). Asking what they have
    // registers nothing, so a reader who changes their mind has left no trace.
    app.post(route(PathSegment.replicas(), PathSegment.browse()), async (c) => {
      const { address } = BrowseRemoteRequestSchema.parse(await c.req.json());
      takeAsLongAsItTakes(c);
      return c.json(respond(BrowsedRemoteSchema, await this.runner.browse(address)));
    });

    app.post(route(PathSegment.replicas()), async (c) => {
      const { address, library_id, root_path, sync_originals } = AddReplicaRequestSchema.parse(await c.req.json());
      takeAsLongAsItTakes(c);
      return c.json(respond(ReplicaSummarySchema, await this.runner.add(address, library_id, root_path, sync_originals)), 201);
    });

    // Catalogues replicate on a timer; this is the reader asking for it now.
    app.post(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.replicate()), async (c) => {
      takeAsLongAsItTakes(c);
      return c.json(respond(ReplicateResultSchema, await this.runner.replicate(c.req.param('libraryId'))));
    });

    // What a page reads once to know which libraries have any replication UI at
    // all (§10). A library missing from the answer replicates with nobody.
    app.get(route(PathSegment.peers()), (c) =>
      c.json(respond(AllPeersResponseSchema, { libraries: this.replication.everyPeer() })),
    );

    // The peers and this device's own appetite for RAW files (§7.10) together:
    // every screen that shows one shows the other, so they are one request.
    app.get(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.peers()), (c) => {
      const libraryId = c.req.param('libraryId');
      return c.json(
        respond(PeersResponseSchema, {
          peers: this.replication.peers(libraryId),
          sync_originals: this.replication.syncsOriginals(libraryId),
          auto_transfer_originals: this.replication.autoTransfersOriginals(libraryId),
        }),
      );
    });

    app.patch(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.originals()), async (c) => {
      const libraryId = c.req.param('libraryId');
      const { sync_originals, auto_transfer_originals } = SyncOriginalsRequestSchema.parse(await c.req.json());
      if (auto_transfer_originals != null) this.replication.setAutoTransfersOriginals(libraryId, auto_transfer_originals);
      if (sync_originals == null) return c.json(respond(SyncOriginalsResponseSchema, { cancelled: 0 }));
      this.replication.setSyncsOriginals(libraryId, sync_originals);
      // The queue would otherwise go on delivering exactly what this turned off.
      const stopped = sync_originals ? 0 : await this.cancelIncoming(libraryId);
      return c.json(respond(SyncOriginalsResponseSchema, { cancelled: stopped }));
    });

    app.patch(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.peers(), PathSegment.param('peerId')), async (c) => {
      const { name } = RenamePeerRequestSchema.parse(await c.req.json());
      this.replication.renamePeer(c.req.param('libraryId'), c.req.param('peerId'), name);
      return c.body(null, 204);
    });

    // What forgetting this peer would put out of reach (§8.4), asked before the
    // button rather than reported after it.
    app.get(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.peers(), PathSegment.param('peerId'), PathSegment.soleHoldings()), (c) => {
      const photos = this.replication.soleHoldings(c.req.param('libraryId'), c.req.param('peerId'));
      return c.json(respond(SoleHoldingsResponseSchema, { photos }));
    });

    app.delete(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.peers(), PathSegment.param('peerId')), (c) => {
      this.replication.forgetPeer(c.req.param('libraryId'), c.req.param('peerId'));
      return c.body(null, 204);
    });

    this.routes = app;
  }
}

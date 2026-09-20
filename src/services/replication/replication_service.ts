import type { Database } from '../../db/driver';
import { latestMigrationMillis } from '../../db/migrate';
import { AppError } from '../../errors';
import {
  REPLICATION_PROTOCOL,
  type AckRequest,
  type AllPeersResponse,
  type ChangesRequest,
  type HandshakeRequest,
  type HandshakeResponse,
  type Page,
  type PairRequest,
  type PairResponse,
  type PairedPeer,
  type PushDoneRequest,
  type PushPageRequest,
  type PushPageResponse,
  type RemoteLibraries,
  type UnpairRequest,
} from '../../schemas/replication';
import { libraryMutex } from '../sync/coordination/library_mutex';
import { applyChanges, dissolveEmptiedStacks, observePage, rebuildCandidates } from './apply';
import { repair } from './repair';
import type { BlobLocations } from '../blobs/blob_locations';
import { DEFAULT_SKEW_MS } from './clock';
import {
  assertPaired,
  deviceName,
  everyPairing,
  forgetPairedPeer,
  linkLibrary,
  markReplicated,
  pairedPeers,
  recordPeerAppetite,
  registerPeer,
  renamePeer,
  setSyncsOriginals,
  syncsOriginals,
} from './pairing';
import { peerId } from './stamps';
import { page } from './stream';
import { advance, coverage, packVector, recordPeer, unpackVector } from './vectors';

// The listening half of replication (docs/replication.md §6): what a peer that
// can reach this server may ask of it. The merge engine never appears here -
// this side only ever *sends*; applying what comes back is the puller's job, on
// the puller's machine (`remote.ts`).

export class ReplicationService {
  constructor(
    private readonly db: Database,
    private readonly locations: BlobLocations,
    private readonly now: () => number = Date.now,
    /**
     * What a photograph whose develop settings arrived is rebuilt through.
     *
     * Required, though most callers pass a no-op: defaulted, the omission reads as
     * nothing at all, and what it means is an arriving edit that never repaints -
     * a peer serving the frame as it was until something else happens to ask.
     */
    private readonly edited: (photoIds: readonly string[]) => void = () => {},
    /**
     * That this library's peers are not what a page last read.
     *
     * Every mutation below owes this, not only the ones a peer makes: a rename or
     * a forget is news to every window except the one that asked, and nothing
     * else on this device ever comes to tell them.
     */
    private readonly changed: (libraryId: string) => void = () => {},
  ) {}

  /**
   * What this device has to offer, for the dialog on the other one that picks
   * (§9.1). A read: it registers nothing and changes nothing here.
   */
  offered(): RemoteLibraries {
    const rows = this.db
      .query(
        `SELECT l.id, l.name, l.read_only,
                (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id AND p.is_deleted = 0) AS photo_count,
                EXISTS (SELECT 1 FROM replication_libraries r WHERE r.library_id = l.id) AS replicating
           FROM libraries l ORDER BY l.name`,
      )
      .all() as { id: string; name: string; read_only: number; photo_count: number; replicating: number }[];
    return {
      peer_id: peerId(this.db),
      name: deviceName(this.db),
      clock_ms: this.now(),
      libraries: rows.map((row) => ({
        id: row.id,
        name: row.name,
        photo_count: row.photo_count,
        read_only: row.read_only !== 0,
        replicating: row.replicating !== 0,
      })),
    };
  }

  /**
   * Records the caller as a peer of one of this device's libraries (§9.1).
   *
   * No secret is presented and none is asked for: the network is the boundary
   * (§11.1). What this does check is that the library exists and can be
   * replicated at all.
   */
  pair(request: PairRequest): PairResponse {
    const library = this.writableLibrary(request.library_id);
    this.db.transaction(() => {
      linkLibrary(this.db, request.library_id);
      registerPeer(this.db, request.library_id, request.peer_id, request.name);
    })();
    this.changed(request.library_id);
    return {
      library_id: request.library_id,
      library_name: library.name,
      peer_id: peerId(this.db),
      name: deviceName(this.db),
      clock_ms: this.now(),
    };
  }

  /**
   * A peer saying it abandoned the pairing it just made (§9.1).
   *
   * Its own request rather than something this side times out: an unfinished
   * peer's vector bounds tombstone collection forever (§8.3), and nothing else
   * would ever come to say the device is not arriving.
   */
  unpair(request: UnpairRequest): void {
    assertPaired(this.db, request.library_id, request.peer_id);
    forgetPairedPeer(this.db, request.library_id, request.peer_id, this.locations);
    this.changed(request.library_id);
  }

  handshake(request: HandshakeRequest): HandshakeResponse {
    // Version first, so a downlevel peer hears "update the app" rather than a
    // half-understood refusal about its pairing.
    if (request.protocol !== REPLICATION_PROTOCOL || request.schema !== latestMigrationMillis()) {
      throw new AppError(
        'CONFLICT',
        `protocol ${request.protocol} (schema ${request.schema}) does not match this server's ` +
          `${REPLICATION_PROTOCOL} (schema ${latestMigrationMillis()}); update the app`,
      );
    }
    assertPaired(this.db, request.library_id, request.peer_id);
    this.writableLibrary(request.library_id);
    const skew = Math.abs(this.now() - request.clock_ms);
    if (skew > DEFAULT_SKEW_MS) {
      throw new AppError(
        'CLOCK_SKEW',
        `the two clocks disagree by ${Math.round(skew / 1000)}s; fix the system time before replicating`,
      );
    }
    // The peer stating what it holds, which is what tombstone GC is bounded by (§8.3).
    recordPeer(this.db, request.library_id, request.peer_id, unpackVector(request.coverage));
    recordPeerAppetite(this.db, request.library_id, request.peer_id, request.wants_originals);
    return {
      protocol: REPLICATION_PROTOCOL,
      schema: latestMigrationMillis(),
      peer_id: peerId(this.db),
      clock_ms: this.now(),
      coverage: packVector(coverage(this.db, request.library_id)),
      wants_originals: syncsOriginals(this.db, request.library_id),
    };
  }

  changes(request: ChangesRequest): Page {
    assertPaired(this.db, request.library_id, request.peer_id);
    return page(this.db, request.library_id, unpackVector(request.held), request.cursor, request.limit);
  }

  /**
   * Applies a page the caller is offering (§6.4), and says what could not be taken.
   *
   * The trust boundary in both directions now: a pushed page is remote input to
   * this catalogue exactly as a pulled one is to the caller's, so it goes through
   * the same stamp bound and the same merge (§11.2).
   */
  async receive(request: PushPageRequest): Promise<PushPageResponse> {
    assertPaired(this.db, request.library_id, request.peer_id);
    this.writableLibrary(request.library_id);
    if (!observePage(this.db, request.page.changes)) {
      throw new AppError('VALIDATION_ERROR', 'page carries malformed or future-dated stamps');
    }
    // Behind the same exclusion every other writer of a photograph's path takes
    // (§6.3). A page can move a photograph and queue the disk move that follows
    // it, and landing that in the middle of a scan's asynchronous walk is the
    // stale-snapshot race `libraryMutex` exists for. The pull direction is already
    // covered - its apply runs inside the session that took the mutex - and this
    // one arrives from outside, on somebody else's schedule.
    const applied = await libraryMutex.run(request.library_id, () =>
      Promise.resolve(
        this.db.transaction(() => {
          const held = applyChanges(this.db, request.library_id, request.page.changes);
          repair(this.db, request.library_id);
          return held;
        })(),
      ),
    );
    // The pictures here are built from the develop settings, so an edit that lands
    // without them leaves this peer showing the frame as it was before somebody
    // changed it, indefinitely - and a push is the direction where that bites
    // hardest, since the device holding the originals is usually the one being
    // pushed to. The same debt an arriving original leaves (§7.8).
    //
    // The changes the apply says it took, rather than the ones whose stamps are
    // absent from what it deferred. A stamp is not a change: one action mints one
    // stamp for every row it touched, so a single deferral read that way answers
    // for all of them - and the answer it gives is "not taken", which is a rebuild
    // never queued and a peer left serving the picture as it was.
    const edited = rebuildCandidates(applied.taken);
    if (edited.length > 0) this.edited(edited);
    return { deferred: applied.deferred };
  }

  /** The end of a push: this peer takes coverage of what it was given (§6.2). */
  finishReceiving(request: PushDoneRequest): void {
    assertPaired(this.db, request.library_id, request.peer_id);
    const delivered = unpackVector(request.delivered);
    this.db.transaction(() => {
      // The same close a pull has, and for the same reason: everything the pusher
      // held is here, so a stack its removals emptied has genuinely ended (§5.2).
      dissolveEmptiedStacks(this.db, request.library_id);
      repair(this.db, request.library_id);
      advance(this.db, request.library_id, delivered);
      recordPeer(this.db, request.library_id, request.peer_id, delivered);
      markReplicated(this.db, request.library_id, request.peer_id);
    })();
    // The end of the push rather than each page of it: a divergence any of them
    // parked is on screen a second later either way, and a page is a round trip
    // that a catalogue arriving makes thousands of.
    this.changed(request.library_id);
  }

  ack(request: AckRequest): void {
    assertPaired(this.db, request.library_id, request.peer_id);
    this.db.transaction(() => {
      recordPeer(this.db, request.library_id, request.peer_id, unpackVector(request.coverage));
      markReplicated(this.db, request.library_id, request.peer_id);
    })();
    this.changed(request.library_id);
  }

  peers(libraryId: string): PairedPeer[] {
    return pairedPeers(this.db, libraryId);
  }

  /** The same, for every library that replicates at all (§10). */
  everyPeer(): AllPeersResponse['libraries'] {
    return everyPairing(this.db);
  }

  /** §7.10: whether this device keeps the RAW files of this library. */
  syncsOriginals(libraryId: string): boolean {
    return syncsOriginals(this.db, libraryId);
  }

  setSyncsOriginals(libraryId: string, value: boolean): void {
    setSyncsOriginals(this.db, libraryId, value);
    this.changed(libraryId);
  }

  renamePeer(libraryId: string, peerId: string, name: string): void {
    renamePeer(this.db, libraryId, peerId, name);
    this.changed(libraryId);
  }

  forgetPeer(libraryId: string, peerId: string): void {
    forgetPairedPeer(this.db, libraryId, peerId, this.locations);
    this.changed(libraryId);
  }

  /** What forgetting this peer would put out of reach (§8.4), for the warning before it. */
  soleHoldings(libraryId: string, peerId: string): string[] {
    return this.locations.soleHoldings(libraryId, peerId);
  }

  private writableLibrary(libraryId: string): { name: string } {
    const library = this.db.query('SELECT name, read_only FROM libraries WHERE id = ?').get(libraryId) as {
      name: string;
      read_only: number;
    } | null;
    if (library == null) throw new AppError('NOT_FOUND', `library not found: ${libraryId}`);
    if (library.read_only !== 0) throw new AppError('READ_ONLY', 'replication requires a writable library');
    return library;
  }
}

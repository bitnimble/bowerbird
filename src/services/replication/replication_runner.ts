import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { Logger } from '../../logger';
import { newId } from '../../schemas/id';
import type { TransferDirection } from '../../schemas/blobs';
import type { BrowsedRemote, ReplicaSummary, ReplicateResult } from '../../schemas/replication';
import type { BlobLocations } from '../blobs/blob_locations';
import type { LibrariesRepository } from '../libraries/libraries_repository';
import type { Library } from '../../schemas/libraries';
import { LEASE_REFRESH_MS, type SyncLocksRepository } from '../sync/coordination/sync_locks_repository';
import { libraryMutex } from '../sync/coordination/library_mutex';
import { collectTombstones } from './gc';
import { drainMaterialisations, unsettled } from './materialise';
import { autoTransfersOriginals, pairedPeers, reachablePeers, recordPeerOutcome, syncsOriginals } from './pairing';
import { addReplica, browseRemote, pullFromRemote, pushToRemote } from './remote';

// What drives replication on this machine (docs/replication.md §6.4, §9): birth a
// replica, and run sessions against the peers it can dial. The catalogue
// replicates by itself; originals only where a library is set to exchange them.

const log = new Logger('replication');

const AUTO_EVERY_MS = 5 * 60 * 1000;

export class ReplicationRunner {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database,
    private readonly locks: SyncLocksRepository,
    private readonly libraries: LibrariesRepository,
    private readonly locations: BlobLocations,
    /**
     * What a library created any other way is announced through (§9.1). A replica
     * is inserted here rather than by `LibrariesService.create`, so without this
     * nothing watches it and nothing ever can: the watcher's update path returns
     * early for a library it was never told about.
     */
    private readonly born: (library: Library) => void,
    /**
     * What a photograph whose develop settings arrived is rebuilt through.
     *
     * Required, both of these, though most callers pass a no-op: defaulted, the
     * omission reads as nothing at all, and what it means is a replica nothing
     * watches or an arriving edit that never repaints. Writing `() => {}` says the
     * caller decided; leaving the argument off would say only that they had not.
     */
    private readonly edited: (photoIds: readonly string[]) => void,
    /**
     * What a session leaves for the views: the peer rows it wrote, and whatever a
     * merge parked (§5.3, §8.6). Nobody asks for a scheduled session, so without
     * this a peer that stopped answering is news only to whoever reloads the page.
     */
    private readonly replicated: (libraryId: string) => void,
    /** Queues the originals one side holds that the other lacks, answering how many. */
    private readonly transferOriginals: (libraryId: string, peerId: string, direction: TransferDirection) => Promise<number>,
  ) {}

  /** §9.1: what a peer is offering, which registers nothing on either side. */
  browse(address: string): Promise<BrowsedRemote> {
    return browseRemote(trimmed(address));
  }

  /** §9.1: pair with one of them and take its catalogue. */
  async add(address: string, libraryId: string, rootPath: string, syncOriginals: boolean): Promise<ReplicaSummary> {
    const cloned = await addReplica(this.db, trimmed(address), libraryId, rootPath, syncOriginals);
    try {
      const result = await this.replicate(cloned.libraryId);
      if (syncOriginals) await this.queueOriginals(cloned.libraryId, cloned.peer, 'pull');
      return { library_id: cloned.libraryId, peer_id: cloned.peer, applied: result.applied };
    } finally {
      // After the clone, not before it: announcing a library starts its first
      // scan, and a scan takes the per-library lease *before its first await* -
      // so told any earlier this hands back with the lease held and the clone
      // above cannot take one, which answers every add with 409.
      //
      // And in a `finally`, because the library exists either way. A clone that
      // failed part-way - peer gone, clocks apart - still committed the row, and
      // one that is never announced is never watched and cannot come to be
      // watched short of a restart.
      this.announce(cloned.libraryId);
    }
  }

  // A listener is somebody else's code, running over a replica that is committed,
  // paired and filled. Letting it throw here would report a failure for something
  // that worked - and the retry refuses, because the library is already present.
  private announce(libraryId: string): void {
    const library = this.libraries.getById(libraryId);
    if (library == null) return;
    try {
      this.born(library);
    } catch (error) {
      log.warn('a listener refused a replica that was already added', { library: libraryId, err: String(error) });
    }
  }

  async replicate(libraryId: string): Promise<ReplicateResult> {
    try {
      const { applied, peers, reached } = await this.session(libraryId);
      if (autoTransfersOriginals(this.db, libraryId)) {
        for (const peerId of reached) await this.exchangeOriginals(libraryId, peerId);
      }
      return { applied, peers };
    } finally {
      // Whatever the session managed, including nothing: an outcome is recorded
      // against each peer before anything here can throw, so a run that gave up
      // part-way is exactly the one with something to say. After the originals are
      // queued, or a page reading the transfers on this news finds none and stops.
      this.replicated(libraryId);
    }
  }

  private async exchangeOriginals(libraryId: string, peerId: string): Promise<void> {
    const library = this.libraries.getById(libraryId);
    if (library == null) return;
    if (!library.read_only && syncsOriginals(this.db, libraryId)) await this.queueOriginals(libraryId, peerId, 'pull');
    if (pairedPeers(this.db, libraryId).some((peer) => peer.peer_id === peerId && peer.wants_originals)) {
      await this.queueOriginals(libraryId, peerId, 'push');
    }
  }

  // The catalogue has already landed, so a queue that refuses is a transfer to retry, not a failed sync.
  private async queueOriginals(libraryId: string, peerId: string, direction: TransferDirection): Promise<void> {
    try {
      const queued = await this.transferOriginals(libraryId, peerId, direction);
      if (queued > 0) log.info('queued originals', { library: libraryId, peer: peerId, direction, queued });
    } catch (error) {
      log.warn('could not queue originals', { library: libraryId, peer: peerId, direction, err: String(error) });
    }
  }

  /**
   * One session with every peer this library can reach, then the close-out every
   * run owes whether or not it dialled anybody.
   *
   * Under the same exclusion a scan takes, because both rewrite the paths a
   * photograph is at: a merge landing a shoot rename mid-walk would have the scan
   * read the moved files as new photographs and the old ones as gone.
   */
  private async session(libraryId: string): Promise<ReplicateResult & { reached: string[] }> {
    // No peers to dial is not nothing to do. A peer that only ever gets dialled -
    // the server, whose paired rows carry no address (§6.4) - takes changes by
    // push, and a push queues file moves and leaves graves without collecting
    // either: `receive` applies, and the drain and the sweep below are the only
    // things that finish the job. Returning here left the server's replication log
    // growing forever and its photographs at the paths they were moved off.
    const peers = reachablePeers(this.db, libraryId);
    const owner = newId();
    if (!this.locks.acquire(libraryId, owner)) {
      throw new AppError('SYNC_IN_PROGRESS', 'a job is already running for this library');
    }
    // A session is one HTTP round trip per page and there is no bound on the pages:
    // a replica being born pulls a whole catalogue, which is minutes. Refreshing
    // only between peers would let a lease that lasts thirty seconds lapse in the
    // middle of one, after which a scan takes it and runs against the library this
    // is still writing to. The scan keeps its lease the same way while it queues.
    const held = setInterval(() => this.locks.refresh(libraryId, owner), LEASE_REFRESH_MS);
    held.unref?.();
    // Around each page's apply rather than the session, because the session is
    // network: held across a peer that has stopped answering rather than failing,
    // this would freeze every binning, rename, scan and incoming push on the
    // library until the connection gave up on itself.
    const guard = <T,>(fn: () => T): Promise<T> => libraryMutex.run(libraryId, () => Promise.resolve(fn()));
    try {
      {
        let applied = 0;
        const reached: string[] = [];
        const edited = new Set<string>();
        for (const peer of peers) {
          this.locks.refresh(libraryId, owner);
          try {
            const replica = { db: this.db, libraryId };
            const taken = await pullFromRemote(replica, peer.address, undefined, guard);
            // Both directions over one dial: the peer that can be reached cannot
            // reach back, so offering is this side's job too (§6.4). After the
            // pull, so what goes over is measured against what just arrived.
            const given = await pushToRemote(replica, peer.address);
            applied += taken.applied;
            for (const photoId of taken.edited) edited.add(photoId);
            recordPeerOutcome(this.db, libraryId, peer.peerId, null);
            reached.push(peer.peerId);
            log.info('replicated', {
              library: libraryId,
              peer: peer.peerId,
              took: taken.applied,
              gave: given.applied,
              deferred: taken.deferred + given.deferred,
            });
          } catch (error) {
            // One unreachable peer is not a failed sync: the others still have
            // things to say, and this one is retried on the next run. Recorded
            // rather than only logged, because a replica quietly out of touch for
            // a fortnight is the failure this is for (§8.6).
            const reason = error instanceof Error ? error.message : String(error);
            recordPeerOutcome(this.db, libraryId, peer.peerId, reason);
            log.warn('could not replicate with a peer', { library: libraryId, peer: peer.peerId, err: reason });
          }
        }
        // The pictures on this device are built from the develop settings, so an
        // edit that arrives without them leaves this peer showing the frame as it
        // was before somebody changed it - and showing it until something else
        // happens to ask, which for a photograph nobody opens here is never. The
        // debt an arriving original leaves, from the other direction (§7.8).
        //
        // Before the two below rather than after them: the session has committed
        // and the vector has advanced, so these edits will not arrive again, and a
        // throw out of either would leave the debt owed until the next start - the
        // "restart the server before any device shows the edit" this exists to end.
        if (edited.size > 0) this.edited([...edited]);
        // Every peer has just said what it holds, which is the only thing that
        // moves the watermark graves are collected below (§8.3).
        await guard(() => collectTombstones(this.db, libraryId));
        await libraryMutex.run(libraryId, () => this.materialise(libraryId));
        return { applied, peers: peers.length, reached };
      }
    } finally {
      clearInterval(held);
      this.locks.release(libraryId, owner);
    }
  }

  /**
   * Moves whatever the merges said to move (§7.4).
   *
   * Public because a scan must drain before it concludes anything: catalogue
   * ahead of disk reads to it as the user moving files back.
   */
  async materialise(libraryId: string): Promise<number> {
    const library = this.libraries.getById(libraryId);
    if (library == null) return 0;
    return drainMaterialisations(this.db, library, this.locations);
  }

  /** What the drain could not make, which a scan has to leave alone (§7.4). */
  stillToMove(libraryId: string): { photoId: string; wasAt: string }[] {
    return unsettled(this.db, libraryId);
  }

  start(): void {
    this.timer ??= setInterval(() => void this.replicateAll(), AUTO_EVERY_MS);
    this.timer.unref?.();
    void this.replicateAll();
  }

  stop(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  private async replicateAll(): Promise<void> {
    const rows = this.db.query('SELECT library_id FROM replication_libraries').all() as { library_id: string }[];
    for (const row of rows) {
      try {
        await this.replicate(row.library_id);
      } catch (error) {
        log.warn('scheduled replication did not run', { library: row.library_id, err: String(error) });
      }
    }
  }
}

// A trailing slash would make every path double-slashed, which some proxies
// answer with a redirect that drops the POST body.
function trimmed(address: string): string {
  return address.trim().replace(/\/+$/, '');
}

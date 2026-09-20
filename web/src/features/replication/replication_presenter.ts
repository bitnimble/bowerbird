import { action, reaction, type IReactionDisposer } from 'mobx';
import { type EvictResult, type Transfer } from '../../../../src/schemas/blobs';
import { type EditConflict } from '../../../../src/schemas/photo_edits';
import { type PhotoTarget } from '../../../../src/schemas/photos';
import { type AllPeersResponse, type BrowsedRemote, type PairedPeer, type PeersResponse, type ReachableAddress } from '../../../../src/schemas/replication';
import { blobsApi } from '../../api/blobs';
import { photoEditsApi } from '../../api/photo_edits';
import { replicationApi } from '../../api/replication';
import { ApiError } from '../../api/request';
import type { LibrariesPresenter } from '../libraries/libraries_presenter';
import type { LibrariesStore } from '../libraries/libraries_store';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { ReplicationPresenterStrings } from './replication_presenter.strings';
import type { ReplicationStore } from './replication_store';

const POLL_MS = 1000;

// All this presenter asks of its two siblings.
type GridToRefresh = Pick<PhotosPresenter, 'reload'>;
type Feedback = Pick<ToastsPresenter, 'show' | 'showError'>;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class ReplicationPresenter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private following: IReactionDisposer | null = null;

  constructor(
    private readonly store: ReplicationStore,
    private readonly librariesStore: LibrariesStore,
    // A replica born here is a library that did not exist a moment ago, so the
    // list it belongs to is the sibling presenter's to re-read.
    private readonly libraries: Pick<LibrariesPresenter, 'load'>,
    private readonly photos: GridToRefresh,
    private readonly toasts: Feedback,
  ) {}

  // Whether a library has peers gates every piece of replication UI (§10), so
  // the peer lists follow the library list for the whole session.
  follow(): void {
    this.following ??= reaction(
      // Joined, so the ids are compared by value: the list is replaced wholesale
      // by every re-read, and an array is a new one each time whether or not a
      // library came or went.
      () => this.librariesStore.libraries.map((library) => library.id).join('\n'),
      () => void this.reload(),
      { fireImmediately: true },
    );
  }

  unfollow(): void {
    this.following?.();
    this.following = null;
    this.stop();
  }

  /** A session ran, or a peer wrote here, and the server said so (`EventsApi`). */
  async libraryChanged(libraryId: string): Promise<void> {
    // A library this page does not have is one it has forgotten, or one it was
    // never shown; asking for its peers answers 404 into an error toast.
    if (!this.librariesStore.byId.has(libraryId)) return;
    await this.loadPeers(libraryId);
    // A divergence is made by a session another device started, so it is
    // announced rather than asked for - and the sidebar is where it lands (§5.3).
    await this.loadConflicts();
  }

  /** Every library that replicates, in one request, plus what they have diverged over. */
  async reload(): Promise<void> {
    try {
      this.putAllPeers((await replicationApi.listAllPeers()).libraries);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotReadDevices(), message(err));
      return;
    }
    await this.loadConflicts();
  }

  async loadPeers(libraryId: string): Promise<void> {
    let answer: PeersResponse;
    try {
      answer = await replicationApi.listPeers(libraryId);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotReadDevices(), message(err));
      return;
    }
    this.putPeers(libraryId, answer.peers, answer.sync_originals);
  }

  /**
   * §7.10: whether this device keeps this library's RAW files at all.
   *
   * Turning it off keeps every original already here - it is a statement about
   * what arrives, not an instruction to delete. "Remove local copy" (§7.6) is
   * what gives the disk back.
   */
  async setSyncOriginals(libraryId: string, value: boolean): Promise<void> {
    let cancelled = 0;
    try {
      ({ cancelled } = await replicationApi.setSyncOriginals(libraryId, value));
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotChangeWhatIsKept(), message(err));
      return;
    }
    if (cancelled > 0) {
      this.toasts.show(ReplicationPresenterStrings.stoppedIncoming(cancelled));
    }
    await this.loadPeers(libraryId);
    await this.refreshTransfers();
  }

  async rename(libraryId: string, peerId: string, name: string): Promise<void> {
    if (name.trim() === '') return;
    try {
      await replicationApi.renamePeer(libraryId, peerId, name.trim());
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotRenameDevice(), message(err));
      return;
    }
    await this.loadPeers(libraryId);
  }

  /**
   * §8.4: forgetting a peer retracts its claims on the originals, and it is the
   * last chance to - a peer that returns after this is refused, so nothing can
   * ever say on its behalf that it held them. Which is also why the originals
   * only *it* is recorded as holding are counted before the question is asked.
   */
  async forget(libraryId: string, peerId: string, confirm: (sole: number) => boolean): Promise<void> {
    const name = this.store.peerName(libraryId, peerId);
    let sole = 0;
    try {
      sole = (await replicationApi.soleHoldings(libraryId, peerId)).photos.length;
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotWorkOutSoleHoldings(name), message(err));
      return;
    }
    if (!confirm(sole)) return;
    try {
      await replicationApi.forgetPeer(libraryId, peerId);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotForget(name), message(err));
      return;
    }
    await this.loadPeers(libraryId);
  }

  /** What to read out to the other device (§9.1). */
  async loadReachable(): Promise<void> {
    try {
      const { addresses } = await replicationApi.reachableAddresses();
      this.putReachable(addresses);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotWorkOutAddress(), message(err));
    }
  }

  /** What a peer is offering (§9.1). A read: nothing is recorded on either side. */
  async browse(address: string): Promise<BrowsedRemote | null> {
    this.clearError();
    try {
      return await replicationApi.browseRemote(address);
    } catch (err) {
      this.failedToLink(message(err));
      return null;
    }
  }

  /** Pairs with one of them and takes its catalogue, which is the whole add (§9.1). */
  async addReplica(address: string, libraryId: string, rootPath: string, syncOriginals: boolean): Promise<boolean> {
    this.clearError();
    try {
      const replica = await replicationApi.addReplica(address, libraryId, rootPath, syncOriginals);
      this.toasts.show(ReplicationPresenterStrings.syncedLibraryAdded(replica.applied));
      await this.libraries.load();
      await this.loadPeers(replica.library_id);
      return true;
    } catch (err) {
      this.failedToLink(message(err));
      // The library is committed before its catalogue arrives, so one that failed
      // partway has left one here. Re-read the list either way.
      await this.libraries.load();
      return false;
    }
  }

  /** A session with every peer this library can dial; the catalogue also does this on its own. */
  async replicate(libraryId: string): Promise<void> {
    if (this.store.replicating != null) return;
    this.busy(libraryId);
    try {
      const { applied, peers } = await replicationApi.replicate(libraryId);
      if (peers === 0) this.toasts.show(ReplicationPresenterStrings.noDeviceReachable());
      // Rows may have moved under every open grid, and only a re-read shows it.
      if (applied > 0) await this.photos.reload();
      await this.loadPeers(libraryId);
      await this.loadConflicts();
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotSync(), message(err));
    } finally {
      this.busy(null);
    }
  }

  async loadConflicts(): Promise<void> {
    try {
      this.putConflicts(await photoEditsApi.listConflicts());
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotReadConflicts(), message(err));
    }
  }

  /** §5.3: the reader picks a candidate, and it lands as a new edit on top of what is there. */
  async keep(photoId: string, sessionId: string): Promise<void> {
    try {
      await photoEditsApi.keepCandidate(photoId, sessionId);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotResolveConflicts(), message(err));
      return;
    }
    await this.loadConflicts();
    await this.photos.reload();
  }

  /** §7.3: queue the originals `peer` lacks. The count is the server's diff, not a guess. */
  async sendMissing(libraryId: string, peerId: string): Promise<void> {
    const name = this.store.peerName(libraryId, peerId);
    try {
      const { queued } = await blobsApi.pushOriginals(libraryId, peerId);
      this.toasts.show(
        queued === 0 ?
          ReplicationPresenterStrings.otherDeviceHoldsEverything(name)
        : ReplicationPresenterStrings.queuedToSend(queued, name),
      );
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotQueueForDevice(name), message(err));
      return;
    }
    await this.refreshTransfers();
  }

  /** The same diff the other way: fetch what `peer` holds that this device lacks. */
  async fetchMissing(libraryId: string, peerId: string): Promise<void> {
    const name = this.store.peerName(libraryId, peerId);
    try {
      const { queued } = await blobsApi.pullOriginals(libraryId, peerId);
      this.toasts.show(
        queued === 0 ?
          ReplicationPresenterStrings.thisDeviceHoldsEverything(name)
        : ReplicationPresenterStrings.queuedToFetch(queued, name),
      );
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotQueueFromDevice(name), message(err));
      return;
    }
    await this.refreshTransfers();
  }

  /**
   * §7.6: gives the disk back, keeping the catalogue. The peer is asked to prove
   * it holds a matching copy before anything is deleted, per photograph, so a
   * partial answer is the normal one and both halves of it are reported.
   */
  async removeLocalCopies(target: PhotoTarget, libraryId: string, peerId: string): Promise<void> {
    const name = this.store.peerName(libraryId, peerId);
    let result: EvictResult;
    try {
      result = await blobsApi.evictOriginals(target, peerId);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotRemoveLocalCopies(), message(err));
      return;
    }
    const gone = result.evicted.length;
    if (result.refused.length === 0) {
      this.toasts.show(ReplicationPresenterStrings.removedLocalCopies(gone, name));
    } else {
      // The first reason stands for the rest: they are overwhelmingly the same
      // one (the peer is unreachable, or holds none of it), and a toast listing
      // a thousand identical lines says less than a count and an example.
      this.toasts.showError(
        gone === 0 ?
          ReplicationPresenterStrings.noneConfirmed(name, result.refused.length)
        : ReplicationPresenterStrings.someConfirmed(gone, result.refused.length, name),
        result.refused[0]!.reason,
      );
    }
    await this.photos.reload();
  }

  /** §7.5: opening a photo whose original is remote is the user asking for it. */
  async fetchOriginal(photoId: string): Promise<void> {
    const pending = this.store.pullFor(photoId);
    if (pending != null && (pending.state === 'queued' || pending.state === 'active')) return;
    try {
      const transfer = await blobsApi.fetchOriginal(photoId);
      if (transfer != null) this.putTransfer(transfer);
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotFetchOriginal(), message(err));
      return;
    }
    await this.refreshTransfers();
  }

  async pause(id: string): Promise<void> {
    await this.control(() => blobsApi.pauseTransfer(id));
  }

  async resume(id: string): Promise<void> {
    await this.control(() => blobsApi.resumeTransfer(id));
  }

  async cancel(id: string): Promise<void> {
    await this.control(() => blobsApi.cancelTransfer(id));
  }

  // Reads the queue once, then keeps reading while anything is queued or active,
  // so per-item progress moves without any view asking again.
  async refreshTransfers(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.poll();
    } finally {
      this.polling = false;
    }
  }

  @action.bound
  stop(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  @action.bound
  clearError(): void {
    this.store.linkError = null;
  }

  private async control(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotChangeTransfer(), message(err));
      return;
    }
    await this.refreshTransfers();
  }

  private async poll(): Promise<void> {
    this.stop();
    const before = new Map(this.store.transfers.map((t) => [t.id, t.state]));
    let transfers: Transfer[];
    try {
      transfers = await blobsApi.listTransfers();
    } catch (err) {
      this.toasts.showError(ReplicationPresenterStrings.couldNotReadTransferQueue(), message(err));
      return;
    }
    this.putTransfers(transfers);

    // A pull that finished landed an original on this disk: the rows' is_missing
    // moved, so the grid re-reads once. Only transitions this session watched -
    // a queue already showing done rows at first read has nothing newly arrived.
    const landed = transfers.some((t) => {
      const was = before.get(t.id);
      return t.direction === 'pull' && t.state === 'done' && was != null && was !== 'done';
    });
    if (landed) await this.photos.reload();

    if (transfers.some((t) => t.state === 'queued' || t.state === 'active')) {
      this.timer = setTimeout(() => void this.refreshTransfers(), POLL_MS);
    }
  }

  @action.bound
  private putPeers(libraryId: string, peers: PairedPeer[], syncOriginals: boolean): void {
    this.store.peersByLibrary.set(libraryId, peers);
    this.store.syncOriginalsByLibrary.set(libraryId, syncOriginals);
  }

  @action.bound
  private putAllPeers(libraries: AllPeersResponse['libraries']): void {
    // Replaced rather than merged: a library absent from the answer replicates
    // with nobody, and left behind it would go on rendering a strip for a peer
    // this device has forgotten.
    this.store.peersByLibrary = new Map(libraries.map((library) => [library.library_id, library.peers]));
    this.store.syncOriginalsByLibrary = new Map(
      libraries.map((library) => [library.library_id, library.sync_originals]),
    );
  }

  @action.bound
  private putReachable(addresses: ReachableAddress[]): void {
    this.store.reachable = addresses;
  }

  @action.bound
  private putConflicts(conflicts: EditConflict[]): void {
    this.store.conflicts = conflicts;
  }

  @action.bound
  private busy(libraryId: string | null): void {
    this.store.replicating = libraryId;
  }

  @action.bound
  private putTransfers(transfers: Transfer[]): void {
    this.store.transfers = transfers;
  }

  @action.bound
  private putTransfer(transfer: Transfer): void {
    this.store.transfers = [...this.store.transfers.filter((t) => t.id !== transfer.id), transfer];
  }

  @action.bound
  private failedToLink(error: string): void {
    this.store.linkError = error;
  }
}

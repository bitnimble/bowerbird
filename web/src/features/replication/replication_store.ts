import { comparer, computed, observable } from 'mobx';
import { type Transfer } from '../../../../src/schemas/blobs';
import { type EditConflict } from '../../../../src/schemas/photo_edits';
import { type PairedPeer } from '../../../../src/schemas/replication';

// Data only: observables + computeds. Every mutation lives on ReplicationPresenter.
export class ReplicationStore {
  @observable.shallow accessor peersByLibrary = new Map<string, PairedPeer[]>();
  /** §7.10, per library this device replicates. */
  @observable.shallow accessor syncOriginalsByLibrary = new Map<string, boolean>();
  @observable.shallow accessor autoTransferByLibrary = new Map<string, boolean>();
  @observable.shallow accessor transfers: Transfer[] = [];
  /**
   * Why joining a library failed, for the dialog that asked.
   *
   * Only that one: it is a form's answer to what was typed into it, and there is
   * one such form on screen at a time. Every other failure here is an action that
   * did not happen, which the app reports as a toast - held in a field like this
   * one it would render under every library's panel at once, saying of each that
   * it is failing to replicate.
   */
  @observable accessor linkError: string | null = null;
  @observable.shallow accessor conflicts: EditConflict[] = [];
  /** Which library a session is running against, so its row can say so. */
  @observable accessor replicating: string | null = null;

  peersOf(libraryId: string): PairedPeer[] {
    return this.peersByLibrary.get(libraryId) ?? [];
  }

  // A library with no peers renders none of the replication UI (§10): this is
  // the gate every strip, badge and panel reads.
  hasPeers(libraryId: string): boolean {
    return this.peersOf(libraryId).length > 0;
  }

  peerName(libraryId: string, peerId: string): string {
    return this.peersOf(libraryId).find((peer) => peer.peer_id === peerId)?.name ?? peerId;
  }

  /**
   * Whether this device keeps this library's RAW files (§7.10). A library nobody
   * has answered for yet reads as keeping them, which is what every library that
   * does not replicate does.
   */
  syncsOriginals(libraryId: string): boolean {
    return this.syncOriginalsByLibrary.get(libraryId) ?? true;
  }

  autoTransfersOriginals(libraryId: string): boolean {
    return this.autoTransferByLibrary.get(libraryId) ?? false;
  }

  transfersOf(libraryId: string): Transfer[] {
    return this.transfers.filter((transfer) => transfer.library_id === libraryId);
  }

  // Compared by value: the queue is re-read every second while it moves, and every tile in the grid
  // reads this.
  @computed({ equals: comparer.structural }) get fetching(): ReadonlySet<string> {
    return new Set(
      this.transfers
        .filter((t) => t.direction === 'pull' && (t.state === 'queued' || t.state === 'active'))
        .map((t) => t.photo_id),
    );
  }

  /** The fetch a photo's open is waiting on: the liveliest pull naming it. */
  pullFor(photoId: string): Transfer | null {
    const pulls = this.transfers.filter((t) => t.photo_id === photoId && t.direction === 'pull');
    return (
      pulls.find((t) => t.state === 'active' || t.state === 'queued' || t.state === 'paused' || t.state === 'failed') ??
      pulls[0] ??
      null
    );
  }

  @computed get anyInFlight(): boolean {
    return this.transfers.some((t) => t.state === 'queued' || t.state === 'active');
  }

  /** Peers whose last session did not happen, wherever the reader is (§8.6). */
  @computed get failingPeers(): number {
    return [...this.peersByLibrary.values()].flat().filter((peer) => peer.last_error != null).length;
  }

  /** Candidates group by photograph: one divergence is every card naming it. */
  @computed get conflictedPhotos(): { photoId: string; candidates: EditConflict[] }[] {
    const byPhoto = new Map<string, EditConflict[]>();
    for (const candidate of this.conflicts) {
      byPhoto.set(candidate.photo_id, [...(byPhoto.get(candidate.photo_id) ?? []), candidate]);
    }
    return [...byPhoto].map(([photoId, candidates]) => ({ photoId, candidates }));
  }
}

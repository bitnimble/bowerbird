/**
 * How a peer is reached, for the parts of the app that move originals rather than rows.
 *
 * Both kinds of peer answer this (docs/replication.md §14.1): a device over HTTP
 * (`replication/peer_transport.ts`), and a backup folder read straight off its mount
 * (`backup/passive_peers.ts`). The transfer queue knows only this.
 */
export interface PeerTransport {
  /** `responseMs` is how long the peer has to start answering, where that is longer than usual. */
  request(peerId: string, path: string, init?: RequestInit, responseMs?: number): Promise<Response>;
  /**
   * Whether this device has any way to reach that peer at all.
   *
   * Asked before a holder is chosen, because half of them cannot be: a peer that joined the
   * library through somebody else replicates its `blob_locations` rows here and keeps its address
   * to itself (§6.4), and a backup lives on a drive that may not be plugged in (§14.4).
   */
  canReach(peerId: string): boolean;
}

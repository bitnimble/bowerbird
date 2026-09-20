import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { PathSegment, route } from '../../schemas/route';
import type { PeerTransport } from '../blobs/transfer_service';

// Reaching a peer, for the parts of the app that move bytes rather than rows.
//
// The same asymmetry the sessions have (§6.4): only one side dials. A replica
// records the address it paired with and calls back to it; a server records
// nothing about the laptop, which is what lets the laptop open no port at all. So
// a peer with no address is not an error in the data, it is the ordinary state of
// everyone who dialled in - and asking to fetch from one is a request that cannot
// be honoured rather than a bug.

/**
 * How long a peer has to say anything at all.
 *
 * Not how long a transfer may take: the body is a chunk, and the deadline is on
 * getting a response rather than on reading one. A peer that accepts the connection
 * and then goes quiet is otherwise a queue that never moves again - the runner is a
 * single worker, the entry stays `active`, and only a restart clears it.
 */
const PEER_RESPONSE_TIMEOUT_MS = 30_000;

export class PairedPeers implements PeerTransport {
  constructor(private readonly db: Database) {}

  canReach(peerId: string): boolean {
    return anyAddress(this.db, peerId) != null;
  }

  async request(peerId: string, path: string, init?: RequestInit): Promise<Response> {
    // By peer rather than by library: a machine is at one address whichever of
    // its libraries is being asked about, and the caller here has a peer in hand
    // rather than a pairing.
    const address = anyAddress(this.db, peerId);
    if (address == null) {
      throw new AppError(
        'VALIDATION_ERROR',
        `peer ${peerId} cannot be reached from here: it dialled this one, and only it knows where this is`,
      );
    }
    // The caller's own signal still cancels, which is what a pause or a cancel
    // uses; the timeout is in addition to it rather than instead.
    const deadline = AbortSignal.timeout(PEER_RESPONSE_TIMEOUT_MS);
    const signal = init?.signal == null ? deadline : AbortSignal.any([init.signal, deadline]);
    return fetch(`${address.replace(/\/+$/, '')}${route(PathSegment.api(), PathSegment.blobs())}${path}`, { ...init, signal });
  }
}

function anyAddress(db: Database, peerId: string): string | null {
  const row = db
    .query('SELECT address FROM replication_peers WHERE peer_id = ? AND address IS NOT NULL LIMIT 1')
    .get(peerId) as { address: string } | null;
  return row?.address ?? null;
}

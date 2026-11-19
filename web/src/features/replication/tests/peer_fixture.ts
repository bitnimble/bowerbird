import { type PairedPeer } from '../../../../../src/schemas/replication';

export function pairedPeer(over: Partial<PairedPeer> = {}): PairedPeer {
  return {
    peer_id: 'laptop',
    name: 'Laptop',
    paired_at: '2026-01-01T00:00:00.000Z',
    last_replicated_at: null,
    last_error: null,
    wants_originals: true,
    reachable: true,
    outdated: null,
    ...over,
  };
}

import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type Outdated, type PairedPeer } from '../../../../../src/schemas/replication';
import { ReplicationStore } from '../replication_store';

function peer(name: string, outdated: Outdated): PairedPeer {
  return {
    peer_id: `${name.toLowerCase().padEnd(16, '0')}`,
    name,
    paired_at: '2026-01-01T00:00:00.000Z',
    last_replicated_at: null,
    last_error: null,
    wants_originals: true,
    outdated,
  };
}

function storeWith(peers: PairedPeer[]): ReplicationStore {
  const store = new ReplicationStore();
  runInAction(() => {
    store.peersByLibrary = new Map([['trip', peers]]);
  });
  return store;
}

test('names no device to update while every build matches', () => {
  const store = storeWith([peer('NAS', null)]);

  expect(store.outdatedPeerOf('trip')).toBeNull();
  expect(store.hasSyncErrors('trip')).toBe(false);
});

// The device receiving a sync records no error of its own, so the version is what says it.
test('reports a device on another version as a sync error, with no error recorded', () => {
  const store = storeWith([peer('Phone', null), peer('NAS', 'peer')]);

  expect(store.outdatedPeerOf('trip')?.name).toBe('NAS');
  expect(store.hasSyncErrors('trip')).toBe(true);
});

test('names this device first, since updating it is the one thing the reader can do here', () => {
  const store = storeWith([peer('NAS', 'peer'), peer('Laptop', 'this_device')]);

  expect(store.outdatedPeerOf('trip')?.name).toBe('Laptop');
});

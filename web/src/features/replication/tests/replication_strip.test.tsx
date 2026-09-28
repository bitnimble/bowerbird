import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { LibrarySchema } from '../../../../../src/schemas/libraries';
import { type PairedPeer } from '../../../../../src/schemas/replication';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { SyncedDevicesPanel } = await import('../synced_devices_panel');
const { StoresProvider, useReplicationStore } = await import('../../../app/stores_context');

afterEach(cleanup);

const LIBRARY = LibrarySchema.parse({
  id: 'library1',
  name: 'Reef',
  root_path: '/fixture/reef',
  bin_name: 'Bin',
  ordering: 'taken_asc',
  last_synced_at: null,
  photo_count: 0,
  missing_photo_count: 0,
  unavailable_photo_count: 0,
  rendered_photo_count: 0,
});

const PEER: PairedPeer = {
  peer_id: 'laptop',
  name: 'Laptop',
  paired_at: '2026-01-01T00:00:00.000Z',
  last_replicated_at: null,
  last_error: null,
  wants_originals: true,
  outdated: null,
};

const RAW_ERROR =
  'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';

function Seed({ peer }: { peer: PairedPeer }): null {
  const store = useReplicationStore();
  useEffect(() => {
    runInAction(() => {
      store.peersByLibrary = new Map([[LIBRARY.id, [peer]]]);
    });
  }, [store, peer]);
  return null;
}

async function open(peer: PairedPeer): Promise<void> {
  render(
    <StoresProvider>
      <Seed peer={peer} />
      <SyncedDevicesPanel library={LIBRARY} />
    </StoresProvider>,
  );
  await act(async () => {});
}

test.each([RAW_ERROR, 'SQLITE_BUSY'])('a sync failure shows safe status and recovery copy for %s', async (last_error) => {
  await open({ ...PEER, last_error, last_replicated_at: new Date(Date.now() - 21 * 60 * 1000).toISOString() });

  const status = screen.getByText("Laptop · Synced 21 min ago · couldn't sync");
  expect(status.getAttribute('aria-description')).toBe("We couldn't sync with this device. Try again.");
  expect(screen.queryByText(last_error, { exact: false })).toBeNull();
});

test('a device without a sync error has no failure copy or tooltip', async () => {
  await open(PEER);

  const status = screen.getByText('Laptop · Never synced');
  expect(status.getAttribute('aria-description')).toBeNull();
  expect(screen.queryByText("couldn't sync", { exact: false })).toBeNull();
});

test.each([
  ['peer', 'update Bowerbird on Laptop to sync'],
  ['this_device', 'update Bowerbird on this device to sync'],
] as const)('an outdated %s keeps update guidance without exposing raw errors', async (outdated, guidance) => {
  await open({ ...PEER, last_error: RAW_ERROR, outdated });

  const status = screen.getByText(`Laptop · Never synced · ${guidance}`);
  expect(status.getAttribute('aria-description')).toBeNull();
  expect(screen.queryByText(RAW_ERROR, { exact: false })).toBeNull();
});

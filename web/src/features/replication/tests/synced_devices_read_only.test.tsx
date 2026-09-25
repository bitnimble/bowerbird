// A read-only library cannot be paired, replicated or take a fetched original, so the panel's
// actions for those are greyed and say why.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Transfer } from '../../../../../src/schemas/blobs';
import { type Library } from '../../../../../src/schemas/libraries';
import { blobsApi } from '../../../api/blobs';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { SyncedDevicesPanel } = await import('../synced_devices_panel');
const { StoresProvider, useReplicationStore } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

blobsApi.listTransfers = (): Promise<Transfer[]> => Promise.resolve([]);

function Seed(): null {
  const replication = useReplicationStore();
  useEffect(() => {
    runInAction(() => {
      replication.peersByLibrary = new Map([
        [
          'lib',
          [
            {
              peer_id: 'laptop',
              name: 'Laptop',
              paired_at: '2026-01-01T00:00:00.000Z',
              last_replicated_at: null,
              last_error: null,
              wants_originals: true,
            },
          ],
        ],
      ]);
    });
  }, [replication]);
  return null;
}

async function openPanel(readOnly: boolean): Promise<void> {
  render(
    <StoresProvider>
      <Seed />
      <SyncedDevicesPanel library={{ id: 'lib', name: 'Reef', read_only: readOnly } as Library} />
    </StoresProvider>,
  );
  await act(async () => {});
}

function refusal(name: string): string | null {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement;
  return button.disabled ? button.getAttribute('aria-description') : null;
}

test('a read-only library greys pairing, replicating and fetching, and says why', async () => {
  await openPanel(true);
  for (const name of ['Sync to another device', 'Sync now', 'Fetch originals']) {
    expect(refusal(name)).toBe('Turn off read-only mode to use this action.');
  }
});

test('a writable library offers them', async () => {
  await openPanel(false);
  for (const name of ['Sync to another device', 'Sync now', 'Fetch originals']) {
    expect(refusal(name)).toBeNull();
  }
});

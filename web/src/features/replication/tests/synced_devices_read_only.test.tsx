// A read-only library cannot take a fetched original, so the panel's action for it is greyed and
// says why.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Transfer } from '../../../../../src/schemas/blobs';
import { blobsApi } from '../../../api/blobs';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';
import { pairedPeer } from './peer_fixture';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { SyncedDevicesPanel } = await import('../synced_devices_panel');
const { StoresProvider, useReplicationStore } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

blobsApi.listTransfers = (): Promise<Transfer[]> => Promise.resolve([]);

function Seed({ keepsOriginals, readOnly }: { keepsOriginals: boolean; readOnly: boolean }): null {
  const replication = useReplicationStore();
  useEffect(() => {
    runInAction(() => {
      replication.syncOriginalsByLibrary = new Map([['lib', keepsOriginals]]);
      replication.peersByLibrary = new Map([['lib', [pairedPeer({ wants_originals: !readOnly })]]]);
    });
  }, [replication, keepsOriginals, readOnly]);
  return null;
}

async function openPanel(readOnly: boolean, keepsOriginals = true): Promise<void> {
  render(
    <StoresProvider>
      <Seed keepsOriginals={keepsOriginals} readOnly={readOnly} />
      <SyncedDevicesPanel library={{ id: 'lib', name: 'Reef', read_only: readOnly }} />
    </StoresProvider>,
  );
  await act(async () => {});
}

function syncRaws(): { greyed: boolean; description: string | null } {
  const button = screen.getByRole('button', { name: 'Sync RAWs' });
  return {
    greyed: button.getAttribute('aria-disabled') === 'true',
    description: button.getAttribute('aria-description'),
  };
}

test('a read-only library greys syncing RAWs, and says why', async () => {
  await openPanel(true);
  expect(syncRaws()).toEqual({ greyed: true, description: 'This library is read-only' });
});

test.each([true, false])(
  'a writable library offers it, keeping originals %s',
  async (keepsOriginals) => {
    await openPanel(false, keepsOriginals);
    expect(syncRaws().greyed).toBe(false);
    expect(
      screen
        .getByRole('radio', {
          name: keepsOriginals ? 'Sync original RAWs' : 'Sync thumbnails only',
        })
        .getAttribute('aria-checked'),
    ).toBe('true');
  },
);

test.each([
  [true, true],
  [false, false],
])('read-only %s greys the originals choice: %s', async (readOnly, greyed) => {
  await openPanel(readOnly);
  for (const name of ['Sync original RAWs', 'Sync thumbnails only']) {
    expect(screen.getByRole('radio', { name }).getAttribute('aria-disabled') === 'true').toBe(
      greyed,
    );
  }
});

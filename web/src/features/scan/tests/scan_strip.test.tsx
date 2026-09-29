import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import type { Transfer } from '../../../../../src/schemas/blobs';
import { LibrarySchema, type LibraryScanStatus } from '../../../../../src/schemas/libraries';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { StoresProvider, useReplicationStore } = await import('../../../app/stores_context');
const { ScanStrip } = await import('../scan_strip');

afterEach(cleanup);

const LIBRARY = LibrarySchema.parse({
  id: 'lib00001',
  root_path: '/photos',
  bin_name: 'Bin',
  name: 'Reef',
  ordering: 'taken_asc',
  last_synced_at: null,
  photo_count: 10,
  missing_photo_count: 4,
  unavailable_photo_count: 1,
  rendered_photo_count: 5,
});

const STATUS: LibraryScanStatus = {
  library_id: LIBRARY.id,
  status: 'idle',
  photos_to_scan: 0,
  photos_scanned: 0,
  photos_added: 0,
  photos_removed: 0,
  photos_moved: 0,
  photos_modified: 0,
  photos_processing: 3,
  photos_processed: 0,
  photos_per_second: null,
};

const PULL: Transfer = {
  id: 'pull',
  library_id: LIBRARY.id,
  photo_id: 'photo001',
  peer_id: 'peer0001',
  direction: 'pull',
  state: 'active',
  bytes_done: 0,
  bytes_total: 100,
  error: null,
  error_code: null,
};

function Transfers({ transfers }: { transfers: Transfer[] }): null {
  const store = useReplicationStore();
  useEffect(() => {
    runInAction(() => { store.transfers = transfers; });
  }, [store, transfers]);
  return null;
}

function Status({ transfers, status }: { transfers: Transfer[]; status: LibraryScanStatus }): JSX.Element {
  return (
    <StoresProvider>
      <Transfers transfers={transfers} />
      <ScanStrip library={LIBRARY} status={status} />
    </StoresProvider>
  );
}

test('fetch and render queues have separate messages and rendering outlasts the last fetch', async () => {
  const view = render(<Status transfers={[PULL]} status={STATUS} />);
  await act(async () => {});
  const fetching = screen.getByText('fetching');
  const rendering = screen.getByText('rendering 3 photos');
  expect(fetching.parentElement).not.toBe(rendering.parentElement);

  await act(async () => {
    view.rerender(<Status transfers={[{ ...PULL, state: 'done' }]} status={STATUS} />);
  });
  expect(screen.queryByText('fetching')).toBeNull();
  expect(screen.getByText('rendering 3 photos')).toBeTruthy();

  await act(async () => {
    view.rerender(<Status transfers={[]} status={{ ...STATUS, photos_processing: 1 }} />);
  });
  expect(screen.getByText('rendering 1 photo')).toBeTruthy();

  await act(async () => {
    view.rerender(<Status transfers={[]} status={{ ...STATUS, status: 'idle', photos_processing: 0 }} />);
  });
  expect(screen.queryByText(/rendering/)).toBeNull();
});

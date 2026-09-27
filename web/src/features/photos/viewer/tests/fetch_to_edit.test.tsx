import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Transfer } from '../../../../../../src/schemas/blobs';
import { type PhotoDetail } from '../../../../../../src/schemas/photos';
import { PathSegment, route } from '../../../../../../src/schemas/route';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { MemoryRouter, useLocation } = await import('react-router-dom');
const { blobsApi } = await import('../../../../api/blobs');
const { StoresProvider, useViewerStore } = await import('../../../../app/stores_context');
const { DetailNav } = await import('../detail_nav');
const { detailMode, editPath } = await import('../detail_mode');

afterEach(cleanup);

const VIEWER = route(PathSegment.photos(), 'p1');
const EDITOR = editPath(VIEWER);

const pull = (state: Transfer['state']): Transfer =>
  ({ id: 't1', library_id: 'lib', photo_id: 'p1', peer_id: 'peer000000000001', direction: 'pull', state, bytes_done: 0, bytes_total: 100 }) as Transfer;

// A photo of a synced library whose original is on another device.
function Seed(): null {
  const viewer = useViewerStore();
  useEffect(() => {
    runInAction(() => {
      viewer.open = { id: 'p1', status: 'ready' };
      viewer.details.set('p1', {
        id: 'p1',
        library_id: 'lib',
        file_path: 'Day1/one.arw',
        has_original: false,
        is_offloaded: false,
        has_embedded: true,
        is_hidden: false,
        stack_id: null,
      } as PhotoDetail);
    });
  }, [viewer]);
  return null;
}

// The viewer and the editor are one page, told which it is by the address.
function Page(): JSX.Element {
  const { pathname } = useLocation();
  return (
    <>
      <Seed />
      <DetailNav
        photoId="p1"
        toolsRef={() => {}}
        zoomRef={() => {}}
        panelsOpen={false}
        onTogglePanels={() => {}}
        stripOpen={null}
        onToggleStrip={() => {}}
        editHref={EDITOR}
        onDone={() => {}}
        proof="hdr"
        hdrOffered={false}
        onProof={() => {}}
        onFullscreen={() => {}}
        mode={detailMode(pathname)}
        edit={null}
      />
      <output aria-label="Address">{pathname}</output>
    </>
  );
}

test('the menu stays open while the original is fetched, and closes when the editor opens', async () => {
  blobsApi.fetchOriginal = () => Promise.resolve(pull('queued'));
  const reads: ((transfers: Transfer[]) => void)[] = [];
  blobsApi.listTransfers = () => new Promise((resolve) => reads.push(resolve));
  render(
    <MemoryRouter initialEntries={[VIEWER]}>
      <StoresProvider>
        <Page />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fetch original and edit' }));
  });

  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Fetching original…' }).getAttribute('aria-disabled')).toBe('true'));
  expect(screen.getByRole('status', { name: 'Address' }).textContent).toBe(VIEWER);

  await act(async () => {
    for (const read of reads) read([pull('done')]);
  });

  await waitFor(() => expect(screen.getByRole('status', { name: 'Address' }).textContent).toBe(EDITOR));
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
});

import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Transfer } from '../../../../../../src/schemas/blobs';
import { type OriginalElsewhere, type PhotoDetail } from '../../../../../../src/schemas/photos';
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
  ({
    id: 't1',
    library_id: 'lib',
    photo_id: 'p1',
    peer_id: 'peer000000000001',
    direction: 'pull',
    state,
    bytes_done: 0,
    bytes_total: 100,
  }) as Transfer;

// A photo of a synced library whose original is on another device.
function Seed({ elsewhere }: { elsewhere: OriginalElsewhere }): null {
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
        original_elsewhere: elsewhere,
        has_embedded: true,
        is_hidden: false,
        stack_id: null,
      } as PhotoDetail);
    });
  }, [viewer, elsewhere]);
  return null;
}

// The viewer and the editor are one page, told which it is by the address.
function Page({ elsewhere }: { elsewhere: OriginalElsewhere }): JSX.Element {
  const { pathname } = useLocation();
  return (
    <>
      <Seed elsewhere={elsewhere} />
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

async function openMenu(elsewhere: OriginalElsewhere): Promise<void> {
  render(
    <MemoryRouter initialEntries={[VIEWER]}>
      <StoresProvider>
        <Page elsewhere={elsewhere} />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
  });
}

async function openMenuAndFetch(): Promise<void> {
  await openMenu('reachable');
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fetch original and edit' }));
  });
}

const pending = (): string | null =>
  screen.getByRole('menuitem', { name: 'Fetching original…' }).getAttribute('aria-disabled');

test('the menu stays pending from the click until the original lands, and closes when the editor opens', async () => {
  const asks: ((transfer: Transfer) => void)[] = [];
  blobsApi.fetchOriginal = () => new Promise((resolve) => asks.push(resolve));
  const reads: ((transfers: Transfer[]) => void)[] = [];
  blobsApi.listTransfers = () => new Promise((resolve) => reads.push(resolve));

  await openMenuAndFetch();
  expect(pending()).toBe('true');

  await act(async () => {
    for (const ask of asks) ask(pull('queued'));
  });
  expect(pending()).toBe('true');
  expect(screen.getByRole('status', { name: 'Address' }).textContent).toBe(VIEWER);

  await act(async () => {
    for (const read of reads) read([pull('done')]);
  });

  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Address' }).textContent).toBe(EDITOR),
  );
  expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
});

test('the row returns to what it was when the fetch cannot be asked for', async () => {
  const refusals: ((error: Error) => void)[] = [];
  blobsApi.fetchOriginal = () => new Promise((_, reject) => refusals.push(reject));

  await openMenuAndFetch();
  expect(pending()).toBe('true');

  await act(async () => {
    for (const refuse of refusals) refuse(new Error('no peer is recorded as holding p1'));
  });

  expect(
    screen.getByRole('menuitem', { name: 'Fetch original and edit' }).getAttribute('aria-disabled'),
  ).not.toBe('true');
  expect(screen.getByRole('status', { name: 'Address' }).textContent).toBe(VIEWER);
});

test('an original only on a device this one cannot reach is not offered, and says why', async () => {
  const asked: string[] = [];
  blobsApi.fetchOriginal = (photoId) => {
    asked.push(photoId);
    return Promise.resolve(pull('queued'));
  };

  await openMenu('unreachable');
  const item = screen.getByRole('menuitem', { name: 'Fetch original and edit' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.getAttribute('aria-description')).toBe(
    "No local copy. The device holding it can't be reached from here.",
  );
  await act(async () => {
    fireEvent.click(item);
  });
  expect(asked).toEqual([]);
});

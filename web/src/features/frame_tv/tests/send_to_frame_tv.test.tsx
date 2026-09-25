// What the selection's menu offers for a Frame TV: nothing while the setting is off, a greyed row
// that says why when no TV answers, one row for one TV, and a choice between several.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import type { FrameTv, SendToFrameTvRequest } from '../../../../../src/schemas/frame_tv';
import { type Library } from '../../../../../src/schemas/libraries';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { DEFAULT_SETTINGS } from '../../../../../src/schemas/settings';
import { frameTvsApi } from '../../../api/frame_tvs';
import { photosApi } from '../../../api/photos';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
restoreApiAfterTests();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { BulkBar } = await import('../../photos/grid/bulk_bar');
const { StoresProvider, useAppSettingsStore, useLibrariesStore, useListingStore, useMarksStore } =
  await import('../../../app/stores_context');
const { SelectionRanges } = await import('../../photos/selection');

const LIVING_ROOM: FrameTv = { id: 'uuid:living', name: 'Living room', host: '10.0.0.5' };
const BEDROOM: FrameTv = { id: 'uuid:bedroom', name: 'Bedroom', host: '10.0.0.6' };
const SEND = 'Send to Samsung Frame TV';
const sent: SendToFrameTvRequest[] = [];

afterEach(cleanup);
beforeEach(() => {
  sent.length = 0;
  photosApi.ids = () => Promise.resolve({ photo_ids: ['aaaaaaaa'] });
  frameTvsApi.send = (body) => {
    sent.push(body);
    return Promise.resolve(undefined);
  };
});

function Seed({ enabled }: { enabled: boolean }): null {
  const settings = useAppSettingsStore();
  const libraries = useLibrariesStore();
  const listing = useListingStore();
  const marks = useMarksStore();
  useEffect(() => {
    runInAction(() => {
      settings.settings = { ...DEFAULT_SETTINGS, frame_tv_enabled: enabled };
      libraries.libraries = [{ id: 'lib', name: 'Reef', read_only: false } as Library];
      listing.source = { kind: 'library', libraryId: 'lib' };
      listing.total = 1;
      listing.rows = new Map([[0, { id: 'aaaaaaaa', stack_size: 1 } as PhotoSummary]]);
      marks.selection = SelectionRanges.of(0, 0);
    });
  }, [settings, libraries, listing, marks, enabled]);
  return null;
}

async function openMenu(tvs: FrameTv[], enabled = true): Promise<void> {
  frameTvsApi.list = () => Promise.resolve({ tvs });
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed enabled={enabled} />
        <BulkBar />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  });
}

test('offers nothing while the integration is off', async () => {
  await openMenu([LIVING_ROOM], false);
  expect(screen.queryByRole('menuitem', { name: SEND })).toBeNull();
});

test('greys the row and says why when no TV answers', async () => {
  await openMenu([]);
  const item = screen.getByRole('menuitem', { name: SEND });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.getAttribute('aria-description')).toBe("We couldn't find a Samsung Frame TV on your network. Check it's on.");
});

test('sends the selection to the one TV that answers', async () => {
  await openMenu([LIVING_ROOM]);
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: SEND }));
  });
  expect(sent).toEqual([{ tv_id: LIVING_ROOM.id, photo_id: 'aaaaaaaa', rendition: null, show: true }]);
});

test('asks which TV where several answer', async () => {
  await openMenu([LIVING_ROOM, BEDROOM]);
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: SEND }));
  });
  expect(screen.getByRole('menuitem', { name: 'Living room' })).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bedroom' }));
  });
  expect(sent.map((each) => each.tv_id)).toEqual([BEDROOM.id]);
});

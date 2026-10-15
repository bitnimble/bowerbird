import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type PhotoMarks, type PhotoSummary } from '../../../../../../src/schemas/photos';
import { registerDom, setShown } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { BulkBar } = await import('../bulk_bar');
const { StoresProvider, useListingStore, useMarksStore, usePresenters } =
  await import('../../../../app/stores_context');
const { SelectionRanges } = await import('../../selection');

afterEach(cleanup);

const marked: PhotoMarks[] = [];

function Seed(): null {
  const listing = useListingStore();
  const marks = useMarksStore();
  const { photos } = usePresenters();
  useEffect(() => {
    marked.length = 0;
    photos.markSelection = (next) => {
      marked.push(next);
      return Promise.resolve();
    };
    runInAction(() => {
      listing.source = { kind: 'library', libraryId: 'lib' };
      listing.total = 2;
      listing.rows = new Map([
        [0, { id: 'p1', stack_size: 1, composite_kind: null, triage: 'picked' } as PhotoSummary],
        [1, { id: 'p2', stack_size: 1, composite_kind: null, triage: 'picked' } as PhotoSummary],
      ]);
      marks.selection = SelectionRanges.of(0, 1);
    });
  }, [listing, marks, photos]);
  return null;
}

async function renderBar({ verdictShown }: { verdictShown: boolean }): Promise<void> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed />
        <BulkBar />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    setShown(screen.getByRole('button', { name: 'Reject' }), verdictShown);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  });
}

test('the verdict stays out of the menu while the bar shows it', async () => {
  await renderBar({ verdictShown: true });
  expect(screen.queryByRole('menuitem', { name: 'Reject' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Clear Pick' })).toBeNull();
});

test('a bar with no room for the verdict offers it in the menu', async () => {
  await renderBar({ verdictShown: false });
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reject' }));
  });
  expect(marked).toEqual([{ triage: 'rejected' }]);
});

test("the menu's verdict clears the one already set, as the bar's does", async () => {
  await renderBar({ verdictShown: false });
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear Pick' }));
  });
  expect(marked).toEqual([{ triage: 'untriaged' }]);
});

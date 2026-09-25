import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { BulkBar } = await import('../bulk_bar');
const { StoresProvider, useListingStore, useMarksStore } = await import('../../../../app/stores_context');
const { SelectionRanges } = await import('../../selection');

afterEach(cleanup);

const photo = (id: string, hidden: boolean): PhotoSummary =>
  ({ id, stack_size: 1, composite_kind: null, is_hidden: hidden }) as PhotoSummary;

function Seed({ rows, total }: { rows: PhotoSummary[]; total: number }): null {
  const listing = useListingStore();
  const marks = useMarksStore();
  useEffect(() => {
    runInAction(() => {
      listing.source = { kind: 'library', libraryId: 'lib' };
      listing.total = total;
      listing.rows = new Map(rows.map((row, index) => [index, row]));
      marks.selection = SelectionRanges.of(0, total - 1);
    });
  }, [listing, marks, rows, total]);
  return null;
}

async function hidingRows(rows: PhotoSummary[], total = rows.length): Promise<string[]> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed rows={rows} total={total} />
        <BulkBar />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  });
  return screen
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
    .filter((text) => /^(Hide|Unhide)\b/.test(text));
}

test('one shown photo offers Hide alone', async () => {
  expect(await hidingRows([photo('p1', false)])).toEqual(['Hide']);
});

test('one hidden photo offers Unhide alone', async () => {
  expect(await hidingRows([photo('p1', true)])).toEqual(['Unhide']);
});

test('several shown photos count what Hide changes', async () => {
  expect(await hidingRows([photo('p1', false), photo('p2', false)])).toEqual(['Hide 2 photos']);
});

test('a mixed selection offers both, each counting its own', async () => {
  expect(await hidingRows([photo('p1', false), photo('p2', true), photo('p3', true)])).toEqual([
    'Hide 1 photo',
    'Unhide 2 photos',
  ]);
});

test('a selection past the loaded rows offers both, uncounted', async () => {
  expect(await hidingRows([photo('p1', false)], 3)).toEqual(['Hide', 'Unhide']);
});

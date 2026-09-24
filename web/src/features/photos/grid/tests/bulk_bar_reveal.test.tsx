import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
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

const invoked: { command: string; args: unknown }[] = [];

beforeEach(() => {
  invoked.length = 0;
  (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: (command: string, args: unknown) => {
        invoked.push({ command, args });
        return Promise.resolve(null);
      },
    },
  };
});
afterEach(cleanup);
afterAll(() => Reflect.deleteProperty(globalThis, '__TAURI__'));

const photo = (id: string, composite = false): PhotoSummary =>
  ({ id, stack_size: 1, composite_kind: composite ? 'panorama' : null }) as PhotoSummary;

function Seed({ rows, selected }: { rows: PhotoSummary[]; selected: number }): null {
  const listing = useListingStore();
  const marks = useMarksStore();
  useEffect(() => {
    runInAction(() => {
      listing.source = { kind: 'library', libraryId: 'lib' };
      listing.total = rows.length;
      listing.rows = new Map(rows.map((row, index) => [index, row]));
      marks.selection = SelectionRanges.of(0, selected - 1);
    });
  }, [listing, marks, rows, selected]);
  return null;
}

async function openMenu(rows: PhotoSummary[], selected: number): Promise<void> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed rows={rows} selected={selected} />
        <BulkBar />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  });
}

test('one photo selected offers its folder, and opens that photo', async () => {
  await openMenu([photo('p1')], 1);

  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open containing folder' }));
  });

  expect(invoked).toEqual([{ command: 'reveal_original', args: { photoId: 'p1' } }]);
});

test('two photos selected do not', async () => {
  await openMenu([photo('p1'), photo('p2')], 2);
  expect(screen.queryByRole('menuitem', { name: 'Open containing folder' })).toBeNull();
});

test('a merged photo, with no file of its own, does not', async () => {
  await openMenu([photo('p1', true)], 1);
  expect(screen.queryByRole('menuitem', { name: 'Open containing folder' })).toBeNull();
});

// What the bar's menu offers a selection, and what it refuses: the actions that would write under a
// read-only library's root are still on the menu, greyed, and say why.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Library } from '../../../../../../src/schemas/libraries';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { type PairedPeer } from '../../../../../../src/schemas/replication';
import { type Shoot } from '../../../../../../src/schemas/shoots';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { BulkBar } = await import('../bulk_bar');
const { StoresProvider, useLibrariesStore, useListingStore, useMarksStore, useReplicationStore, useShootsStore } =
  await import('../../../../app/stores_context');
const { SelectionRanges } = await import('../../selection');

afterEach(cleanup);

function shoot(id: string, name: string): Shoot {
  return {
    id,
    parent_id: null,
    library_id: 'lib',
    folder_path: name,
    name,
    description: null,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count: 1,
    is_hidden: false,
    hidden_directly: false,
  };
}

const DAWN = { kind: 'shoot', id: 'dawn', name: 'Dawn' } as const;

function Seed({ readOnly, synced }: { readOnly: boolean; synced: boolean }): null {
  const libraries = useLibrariesStore();
  const listing = useListingStore();
  const marks = useMarksStore();
  const shoots = useShootsStore();
  const replication = useReplicationStore();
  useEffect(() => {
    runInAction(() => {
      if (synced) replication.peersByLibrary = new Map([['lib', [{ peer_id: 'laptop', name: 'Laptop' } as PairedPeer]]]);
      libraries.libraries = [{ id: 'lib', name: 'Reef', read_only: readOnly } as Library];
      shoots.shoots = [shoot('dawn', 'Dawn'), shoot('dusk', 'Dusk')];
      listing.source = { kind: 'shoot', shootId: DAWN.id };
      listing.total = 1;
      listing.rows = new Map([[0, { id: 'p1', shoot_id: 'dawn', stack_size: 1 } as PhotoSummary]]);
      marks.selection = SelectionRanges.of(0, 0);
    });
  }, [libraries, listing, marks, shoots, replication, readOnly, synced]);
  return null;
}

async function openMenu(readOnly: boolean, synced = false): Promise<void> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed readOnly={readOnly} synced={synced} />
        <BulkBar collection={DAWN} />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
  });
}

test('filing into and out of a shoot is greyed on a read-only library, and says why', async () => {
  await openMenu(true);
  for (const name of ['Move to another shoot', 'Remove from Dawn']) {
    const item = screen.getByRole('menuitem', { name });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('aria-description')).toBe('Turn off read-only mode to use this action.');
  }
});

test('one photo is not a panorama, and the row says so', async () => {
  await openMenu(false);
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Merge photos' }));
  });
  const item = screen.getByRole('menuitem', { name: 'To panorama' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.getAttribute('aria-description')).toBe('Select at least 2 photos.');
});

test('removing a local copy is under Sync, and only in a synced library', async () => {
  await openMenu(false);
  expect(screen.queryByRole('menuitem', { name: 'Sync' })).toBeNull();
  cleanup();

  await openMenu(false, true);
  expect(screen.queryByRole('button', { name: /Remove local copy/ })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync' }));
  });
  expect(screen.getByRole('menuitem', { name: 'Remove local copy (kept on Laptop)' })).toBeTruthy();
});

test('a writable library offers both', async () => {
  await openMenu(false);
  for (const name of ['Move to another shoot', 'Remove from Dawn']) {
    const item = screen.getByRole('menuitem', { name });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    expect(item.getAttribute('aria-description')).toBeNull();
  }
});

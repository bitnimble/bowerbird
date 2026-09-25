// What a selection in a read-only library is offered: the actions that would write under its root
// are still on the menu, greyed, and say why.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Library } from '../../../../../../src/schemas/libraries';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { type Shoot } from '../../../../../../src/schemas/shoots';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { BulkBar } = await import('../bulk_bar');
const { StoresProvider, useLibrariesStore, useListingStore, useMarksStore, useShootsStore } =
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

function Seed({ readOnly }: { readOnly: boolean }): null {
  const libraries = useLibrariesStore();
  const listing = useListingStore();
  const marks = useMarksStore();
  const shoots = useShootsStore();
  useEffect(() => {
    runInAction(() => {
      libraries.libraries = [{ id: 'lib', name: 'Reef', read_only: readOnly } as Library];
      shoots.shoots = [shoot('dawn', 'Dawn'), shoot('dusk', 'Dusk')];
      listing.source = { kind: 'shoot', shootId: DAWN.id };
      listing.total = 1;
      listing.rows = new Map([[0, { id: 'p1', shoot_id: 'dawn', stack_size: 1 } as PhotoSummary]]);
      marks.selection = SelectionRanges.of(0, 0);
    });
  }, [libraries, listing, marks, shoots, readOnly]);
  return null;
}

async function openMenu(readOnly: boolean): Promise<void> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed readOnly={readOnly} />
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

test('a writable library offers both', async () => {
  await openMenu(false);
  for (const name of ['Move to another shoot', 'Remove from Dawn']) {
    const item = screen.getByRole('menuitem', { name });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    expect(item.getAttribute('aria-description')).toBeNull();
  }
});

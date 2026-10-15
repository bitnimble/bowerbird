import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { registerDom, setShown } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { GridControls } = await import('../grid_controls');
const { StoresProvider, useListingStore } = await import('../../../../app/stores_context');

afterEach(cleanup);

function Seed(): null {
  const listing = useListingStore();
  useEffect(() => {
    runInAction(() => {
      listing.photoTotal = 3;
    });
  }, [listing]);
  return null;
}

async function openMenu({ countShown }: { countShown: boolean }): Promise<HTMLElement> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed />
        <GridControls />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    setShown(screen.getByText('3 photos'), countShown);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Grid options' }));
  });
  return screen.getByRole('menu');
}

test('the count stays out of the menu while the row shows it', async () => {
  expect(within(await openMenu({ countShown: true })).queryByText('3 photos')).toBeNull();
});

test('a row with no room for the count shows it in the menu', async () => {
  expect(within(await openMenu({ countShown: false })).getByText('3 photos')).toBeDefined();
});

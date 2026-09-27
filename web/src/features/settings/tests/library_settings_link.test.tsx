// A library's settings dialog is an address, so the sidebar's "Sync errors" row can open it at the
// section the error is in.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Library } from '../../../../../src/schemas/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { MemoryRouter, Route, Routes, useLocation } = await import('react-router-dom');
const { LibraryList } = await import('../library_list');
const { StoresProvider, useLibrariesStore } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

const LIBRARY = {
  id: 'lib',
  name: 'Reef',
  root_path: '/srv/reef',
  photo_count: 12,
  render_skip_full: [],
  render_skip_max: [],
} as unknown as Library;

function Seed(): null {
  const libraries = useLibrariesStore();
  useEffect(() => {
    runInAction(() => (libraries.libraries = [LIBRARY]));
  }, [libraries]);
  return null;
}

let location = '';
function Where(): null {
  location = useLocation().pathname;
  return null;
}

async function openAt(path: string): Promise<void> {
  render(
    <MemoryRouter initialEntries={[path]}>
      <StoresProvider>
        <Seed />
        <Where />
        <Routes>
          <Route path="/settings/:tab?/:libraryId?/:section?" element={<LibraryList />} />
        </Routes>
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

test("a library's address opens its settings, focused on the sync section", async () => {
  await openAt('/settings/libraries/lib/sync');
  expect(screen.getByRole('dialog', { name: 'Settings for Reef' })).toBeTruthy();
  const sync = screen.getByRole('group', { name: 'Synced devices' });
  await waitFor(() => expect(document.activeElement?.contains(sync)).toBe(true));
});

test('the settings button opens the dialog and closing it returns to the libraries', async () => {
  await openAt('/settings/libraries');
  expect(screen.queryByRole('dialog')).toBeNull();

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Settings' })));
  expect(location).toBe('/settings/libraries/lib');
  expect(screen.getByRole('dialog', { name: 'Settings for Reef' })).toBeTruthy();

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })));
  expect(location).toBe('/settings/libraries');
});

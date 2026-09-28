// A library's settings dialog is an address, so the sidebar's "Sync errors" row can open it at the
// section the error is in.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Library } from '../../../../../src/schemas/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';
import { LibrariesPresenter } from '../../libraries/libraries_presenter';
import { LibrariesStore } from '../../libraries/libraries_store';
import { ToastsPresenter } from '../../toasts/toasts_presenter';
import { ToastsStore } from '../../toasts/toasts_store';

registerDom();
const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { MemoryRouter, Route, Routes, useLocation } = await import('react-router-dom');
const { LibraryList } = await import('../library_list');
const { StoresProvider, useLibrariesStore } = await import('../../../app/stores_context');
const { TooltipProvider } = await import('../../../ui/tooltip');

restoreApiAfterTests();
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, '__TAURI__');
});

const LIBRARY = {
  id: 'lib',
  name: 'Reef',
  root_path: '/srv/reef',
  photo_count: 12,
  render_skip_full: [],
  render_skip_max: [],
  denoiser: 'galosh',
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
        <TooltipProvider delay={0}>
          <Routes>
            <Route path="/settings/:tab?/:libraryId?/:section?" element={<LibraryList />} />
          </Routes>
        </TooltipProvider>
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

test('desktop library paths are links with a tooltip that opens their root folder', async () => {
  const invoked: { command: string; args: unknown }[] = [];
  Reflect.set(globalThis, '__TAURI__', {
    core: {
      invoke: async (command: string, args: unknown) => {
        invoked.push({ command, args });
        return null;
      },
    },
  });
  await openAt('/settings/libraries');

  const link = screen.getByRole('link', { name: '/srv/reef' });
  expect(screen.queryByRole('button', { name: 'Open library folder' })).toBeNull();
  await act(async () => {
    link.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(screen.getByRole('tooltip').textContent).toBe('Open library folder');

  await act(async () => fireEvent.click(link));
  expect(invoked).toEqual([{ command: 'open_folder', args: { path: '/srv/reef' } }]);
  expect(location).toBe('/settings/libraries');
});

test('web library tiles show the path as plain text', async () => {
  Reflect.deleteProperty(globalThis, '__TAURI__');
  await openAt('/settings/libraries');
  expect(screen.queryByRole('link', { name: '/srv/reef' })).toBeNull();
  expect(screen.getByText('/srv/reef · 12 photos')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open library folder' })).toBeNull();
});

test('opening a missing library folder reports the native error', async () => {
  Reflect.set(globalThis, '__TAURI__', {
    core: {
      invoke: async () => {
        throw '/srv/reef is not a folder on this device';
      },
    },
  });
  const toasts = new ToastsStore();
  const presenter = new LibrariesPresenter(new LibrariesStore(), new ToastsPresenter(toasts));

  await presenter.openFolder('/srv/reef');

  expect(toasts.toasts).toEqual([
    {
      id: 1,
      tone: 'error',
      message: "Couldn't open the library folder",
      detail: '/srv/reef is not a folder on this device',
    },
  ]);
});

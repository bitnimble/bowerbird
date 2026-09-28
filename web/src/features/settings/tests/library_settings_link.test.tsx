// A library's settings dialog is an address, so the sidebar's "Sync errors" row can open it at the
// section the error is in.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Library, type LibraryScanStatus } from '../../../../../src/schemas/libraries';
import { librariesApi } from '../../../api/libraries';
import type { Activity } from '../../../../../src/schemas/activity';
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
  missing_photo_count: 3,
  unavailable_photo_count: 1,
  rendered_photo_count: 7,
  render_skip_full: [],
  render_skip_max: [],
  denoiser: 'galosh',
} as unknown as Library;

const IDLE: LibraryScanStatus = {
  library_id: LIBRARY.id,
  status: 'idle',
  photos_to_scan: 0,
  photos_scanned: 0,
  photos_added: 0,
  photos_removed: 0,
  photos_moved: 0,
  photos_modified: 0,
  photos_processing: 0,
  photos_processed: 0,
  photos_per_second: null,
};

let reportedLibrary = LIBRARY;
let reportedStatus = IDLE;
let reportedActivity: Activity[] = [];
let reportedGlobal: Activity[] = [];
beforeEach(() => {
  reportedLibrary = LIBRARY;
  reportedStatus = IDLE;
  reportedActivity = [];
  reportedGlobal = [];
  librariesApi.list = () => Promise.resolve([reportedLibrary]);
  librariesApi.scanStatus = () => Promise.resolve(reportedStatus);
  librariesApi.activity = () => Promise.resolve({
    libraries: [{ ...reportedLibrary, scan: reportedStatus, activities: reportedActivity }],
    global: reportedGlobal,
  });
});

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
  expect(screen.getByText('/srv/reef · 12 photos (3 missing, 1 unavailable, 7 rendered)')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open library folder' })).toBeNull();
});

test('library counts and the render queue keep updating after fetching ends', async () => {
  reportedStatus = { ...IDLE, photos_processing: 3 };
  await openAt('/settings/libraries');
  expect(screen.getByText('rendering 3 photos')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

  reportedLibrary = {
    ...LIBRARY,
    photo_count: 15,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 15,
  };
  reportedStatus = IDLE;
  await waitFor(() => {
    expect(screen.getByText('/srv/reef · 15 photos (0 missing, 0 unavailable, 15 rendered)')).toBeTruthy();
    expect(screen.queryByText(/rendering/)).toBeNull();
  }, { timeout: 2500 });
});

test('work started on the server is visible without client action flags', async () => {
  reportedActivity = [
    { kind: 'syncing', count: 1 }, { kind: 'fetching', count: 2 },
    { kind: 'sending', count: 3 }, { kind: 'backing_up', count: 1 },
    { kind: 'preparing', count: 1 }, { kind: 'merging', count: 1 },
    { kind: 'exporting', count: 1 }, { kind: 'refreshing_metadata', count: 1 },
  ];
  reportedGlobal = [{ kind: 'catalogue_backup', count: 1 }, { kind: 'pruning', count: 1 }];
  await openAt('/settings/libraries');
  for (const text of [
    'syncing', 'fetching', 'sending 3 originals', 'backing up originals',
    'preparing 1 photo', 'merging photos', 'exporting 1 photo', 'refreshing photo details',
    'backing up catalogue', 'cleaning up generated files',
  ]) expect(screen.getByText(text)).toBeTruthy();
});

test('a scan started elsewhere offers Stop for its own library', async () => {
  reportedStatus = { ...IDLE, status: 'processing', photos_to_scan: 10 };
  await openAt('/settings/libraries');
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Scan library' })).toBeNull();
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

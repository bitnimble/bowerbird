import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type BackupStatus } from '../../../../../src/schemas/backup';
import { type Library } from '../../../../../src/schemas/libraries';
import { backupApi } from '../../../api/backup';
import { browseApi } from '../../../api/browse';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { StoresProvider, useBackupStore } = await import('../../../app/stores_context');
const { BackupPanel } = await import('../backup_panel');

restoreApiAfterTests();
const bridge = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
afterEach(() => {
  cleanup();
  if (bridge == null) Reflect.deleteProperty(globalThis, '__TAURI__');
  else Object.defineProperty(globalThis, '__TAURI__', bridge);
});

const status: BackupStatus = {
  library_id: 'lib',
  peer_id: 'backup',
  name: 'Backup',
  path: '/backup',
  available: true,
  owed: 0,
  backed_up: 12,
  local_bytes: 3_000_000_000,
  local_budget_bytes: null,
  offloaded: 0,
  last_run_at: null,
  last_error: null,
};

function library(readOnly: boolean): Library {
  return {
    id: 'lib',
    root_path: '/photos',
    bin_name: readOnly ? null : 'Bin',
    read_only: readOnly,
    name: 'Photos',
    ordering: 'taken_asc',
    rendition_source: 'render',
    rendition_hdr: true,
    render_skip_full: [],
    render_skip_max: [],
    denoiser: 'galosh',
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 12,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 0,
  };
}

function Seed({ seeded }: { seeded: BackupStatus }): null {
  const backup = useBackupStore();
  useEffect(() => {
    runInAction(() => {
      backup.byLibrary = new Map([[seeded.library_id, seeded]]);
    });
  }, [backup, seeded]);
  return null;
}

async function open(readOnly: boolean, seeded: BackupStatus = status): Promise<void> {
  render(
    <StoresProvider>
      <Seed seeded={seeded} />
      <BackupPanel library={library(readOnly)} />
    </StoresProvider>,
  );
  await act(async () => {});
}

test('a read-only library disables its storage limit and says why', async () => {
  await open(true);

  const field = screen.getByRole('spinbutton', { name: 'Local storage limit (GB)' });
  expect(field.matches(':disabled')).toBe(true);
  expect(field.closest('[aria-description]')?.getAttribute('aria-description')).toBe(
    'Read-only libraries cannot remove local originals.',
  );
});

test('a writable library keeps its storage limit editable', async () => {
  await open(false);

  const field = screen.getByRole('spinbutton', { name: 'Local storage limit (GB)' });
  expect(field.matches(':disabled')).toBe(false);
  expect(field.closest('[aria-description]')).toBeNull();
});

test('removing offers to fetch back the photos only the backup holds', async () => {
  const removed: boolean[] = [];
  backupApi.remove = (_libraryId, fetchFirst) => {
    removed.push(fetchFirst);
    return Promise.resolve();
  };
  await open(false, { ...status, offloaded: 2 });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
  });
  expect(screen.getByRole('dialog', { name: 'Remove backup folder "Backup"?' })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and remove' }));
  });

  expect(removed).toEqual([true]);
});

test('fetching back shows how far it has got and which file it is on', async () => {
  let finish = (): void => {};
  backupApi.remove = () => new Promise((resolve) => (finish = resolve));
  backupApi.fetchBackProgress = () =>
    Promise.resolve({ done: 1, total: 4, current: { path: 'trip/two.arw', bytes_done: 50, bytes_total: 100 } });
  await open(false, { ...status, offloaded: 4 });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and remove' }));
  });

  const bar = screen.getByRole('progressbar', { name: '1 of 4 photos fetched' }) as HTMLProgressElement;
  expect(bar.value).toBe(1.5);
  expect(screen.getByText('trip/two.arw · 50%')).toBeTruthy();
  await act(async () => finish());
});

test('what the backup holds, what this device keeps and where the backup is are one line', async () => {
  await open(false);

  expect(screen.getByText('12 photos backed up · using 3.0 GB · /backup')).toBeTruthy();
});

test.each(['web', 'desktop'])('backup folder selection uses the shared %s chooser directly', async (platform) => {
  const calls: { libraryId: string; path: string }[] = [];
  const commands: string[] = [];
  backupApi.setFolder = async (libraryId, path) => {
    calls.push({ libraryId, path });
    return { ...status, path };
  };
  browseApi.get = async (path) => ({ path: path ?? '/home/reader', parent: null, directories: [], writable: true });
  if (platform === 'desktop') {
    Object.defineProperty(globalThis, '__TAURI__', {
      configurable: true,
      value: { core: { invoke: async (command: string) => {
        commands.push(command);
        return { kind: 'picked', path: '/backups' };
      } } },
    });
  }
  render(<StoresProvider><BackupPanel library={library(false)} /></StoresProvider>);

  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Choose folder' })); });
  if (platform === 'web') {
    const dialog = screen.getByRole('dialog', { name: 'Choose folder' });
    expect(calls).toEqual([]);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '/backups' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' })); });
  }

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(calls).toEqual([{ libraryId: 'lib', path: '/backups' }]);
  expect(commands).toEqual(platform === 'desktop' ? ['pick_export_folder'] : []);

  backupApi.remove = async () => {};
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove backup' })); });
  const removeDialog = screen.getByRole('dialog', { name: 'Remove backup folder "Backup"?' });
  await act(async () => { fireEvent.click(within(removeDialog).getByRole('button', { name: 'Remove backup' })); });
  expect(screen.getByRole('button', { name: 'Choose folder' })).toBeTruthy();
  expect(calls).toEqual([{ libraryId: 'lib', path: '/backups' }]);
});

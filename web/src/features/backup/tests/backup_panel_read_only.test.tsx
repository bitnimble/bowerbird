import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type BackupStatus } from '../../../../../src/schemas/backup';
import { type Library } from '../../../../../src/schemas/libraries';
import { backupApi } from '../../../api/backup';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { StoresProvider, useBackupStore } = await import('../../../app/stores_context');
const { BackupPanel } = await import('../backup_panel');

restoreApiAfterTests();
afterEach(cleanup);

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
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 12,
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

  const field = screen.getByRole('spinbutton', { name: 'Storage limit (GB)' });
  expect(field.matches(':disabled')).toBe(true);
  expect(field.closest('[aria-description]')?.getAttribute('aria-description')).toBe(
    'Read-only libraries cannot remove local originals.',
  );
});

test('a writable library keeps its storage limit editable', async () => {
  await open(false);

  const field = screen.getByRole('spinbutton', { name: 'Storage limit (GB)' });
  expect(field.matches(':disabled')).toBe(false);
  expect(field.closest('[aria-description]')).toBeNull();
});

test('stopping offers to fetch back the photos only the backup holds', async () => {
  const removed: boolean[] = [];
  backupApi.remove = (_libraryId, fetchFirst) => {
    removed.push(fetchFirst);
    return Promise.resolve();
  };
  await open(false, { ...status, offloaded: 2 });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop backing up' }));
  });
  expect(screen.getByRole('dialog', { name: 'Stop backing up to "Backup"?' })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and stop' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Stop backing up' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and stop' }));
  });

  const bar = screen.getByRole('progressbar', { name: '1 of 4 photos fetched' }) as HTMLProgressElement;
  expect(bar.value).toBe(1.5);
  expect(screen.getByText('trip/two.arw · 50%')).toBeTruthy();
  await act(async () => finish());
});

test('what the backup holds and what this device keeps is one line', async () => {
  await open(false);

  expect(screen.getByText('12 photos backed up · using 3.0 GB')).toBeTruthy();
});

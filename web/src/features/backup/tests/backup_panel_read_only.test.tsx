import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type BackupStatus, type ConfiguredBackupStatus } from '../../../../../src/schemas/backup';
import { type Library } from '../../../../../src/schemas/libraries';
import { backupApi } from '../../../api/backup';
import { browseApi } from '../../../api/browse';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';
import { backupReport, backupStatus } from './backup_fixture';

registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { StoresProvider, useBackupStore } = await import('../../../app/stores_context');
const { usePresenters } = await import('../../../app/stores_context');
const { BackupPanel } = await import('../backup_panel');
const { BackupStrip } = await import('../backup_strip');
const { MemoryRouter } = await import('react-router-dom');

restoreApiAfterTests();
const bridge = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
afterEach(() => {
  cleanup();
  if (bridge == null) Reflect.deleteProperty(globalThis, '__TAURI__');
  else Object.defineProperty(globalThis, '__TAURI__', bridge);
});

const status = backupStatus();
let serverStatus: BackupStatus = status;
beforeEach(() => {
  serverStatus = status;
  backupApi.list = async () => ({ backups: [serverStatus] });
});

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

async function open(
  readOnly: boolean,
  seeded: BackupStatus = status,
  strip = false,
): Promise<void> {
  serverStatus = seeded;
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed seeded={seeded} />
        <BackupPanel library={library(readOnly)} />
        {strip && <BackupStrip libraryId="lib" />}
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

test('a read-only library disables its storage limit and says why', async () => {
  await open(true);

  const field = screen.getByRole('spinbutton', { name: 'Local storage limit (GB)' });
  expect(field.matches(':disabled')).toBe(true);
  expect(field.closest('[aria-description]')?.getAttribute('aria-description')).toBe(
    "Read-only libraries can't remove local originals.",
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
    serverStatus = { library_id: 'lib', configured: false };
    return Promise.resolve();
  };
  await open(false, { ...status, coverage: { ...status.coverage, offloaded: 2 } });

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
    Promise.resolve({
      done: 1,
      total: 4,
      failed: 0,
      paused: 0,
      cancelled: 0,
      current: { path: 'trip/two.arw', bytes_done: 50, bytes_total: 100 },
    });
  await open(false, { ...status, coverage: { ...status.coverage, offloaded: 4 } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and remove' }));
  });

  const bar = screen.getByRole('progressbar', { name: '1 of 4 originals restored' });
  expect(bar.getAttribute('value')).toBe('1.5');
  expect(screen.getByText('trip/two.arw · 50%')).toBeTruthy();
  await act(async () => finish());
});

test.each([
  ['current', 'No originals are waiting to back up.', 'Back up now'],
  ['waiting', 'Waiting to back up 3 originals', 'Back up now'],
  ['paused', 'Backup paused with 3 originals remaining', 'Resume'],
  ['unavailable', 'Backup folder is missing.', 'Retry'],
] as const)(
  'the %s backup has the same persistent status in the panel and strip',
  async (state, label, action) => {
    const seeded = backupStatus({
      status: state,
      access: state === 'unavailable' ? 'folder_missing' : 'ready',
      coverage: { ...status.coverage, pending: 3 },
    });
    await open(false, seeded, true);
    expect(screen.getAllByText(label)).toHaveLength(2);
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View backup' }).getAttribute('href')).toBe(
      '/settings/libraries/lib/backup',
    );
    if (state === 'unavailable')
      expect(
        screen.getByText(
          'Connect the backup drive or share, then retry. Choose its folder if it has moved.',
        ),
      ).toBeTruthy();
  },
);

test('working shows the current original and byte progress while protecting target settings', async () => {
  await open(
    false,
    backupStatus({
      status: 'working',
      activity: {
        phase: 'copying',
        done: 2,
        total: 12,
        current: { path: 'trip/three.arw', bytes_done: 12_000_000, bytes_total: 24_000_000 },
      },
    }),
    true,
  );
  expect(screen.getAllByText('Backing up 2 of 12 originals')).toHaveLength(2);
  expect(screen.getAllByText('trip/three.arw · 12 of 24 MB')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Remove backup' }).matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Choose folder' }).matches(':disabled')).toBe(true);
  expect(
    screen.getByRole('spinbutton', { name: 'Local storage limit (GB)' }).matches(':disabled'),
  ).toBe(true);
});

test('current conflicts show file paths and recovery separately from historical reports', async () => {
  const issues: ConfiguredBackupStatus['issues'] = {
    total: 1,
    counts: [{ code: 'path_conflict', count: 1 }],
    samples: [
      {
        code: 'path_conflict',
        phase: 'copying',
        photo_id: 'p',
        path: 'trip/conflict.arw',
      },
    ],
  };
  await open(
    false,
    backupStatus({
      status: 'attention',
      issues,
      last_backup_report: backupReport({ outcome: 'partial', copied: 2, issues }),
    }),
    true,
  );
  expect(screen.getAllByText('A backup location contains a different file.')).toHaveLength(4);
  const disclosure = screen.getByText('Current backup issues (1)');
  fireEvent.click(disclosure);
  const details = disclosure.closest('details');
  expect(details).toBeTruthy();
  if (details == null) throw new Error('missing disclosure');
  expect(within(details).getByText('trip/conflict.arw')).toBeTruthy();
  expect(
    within(details).getByText(
      'Compare both files before choosing which to keep, move, or replace, then retry.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Last backup report')).toBeTruthy();
});

test('missing copies recommend another surviving copy without claiming global loss', async () => {
  await open(
    false,
    backupStatus({
      status: 'attention',
      coverage: {
        ...status.coverage,
        backed_up: 10,
        offloaded: 2,
        missing: 2,
        missing_originals: 2,
      },
    }),
  );
  expect(
    screen.getByText(
      "We couldn't find 2 originals on this device or this backup. Look for another copy before making changes.",
    ),
  ).toBeTruthy();
  expect(screen.getByText('2 originals have no local copy on this device.')).toBeTruthy();
});

test('a failed fetch keeps the removal dialog open and shows successful and failed counts', async () => {
  let reject: (error: Error) => void = () => {};
  backupApi.remove = () =>
    new Promise((_resolve, failed) => {
      reject = failed;
    });
  backupApi.fetchBackProgress = async () => ({
    done: 1,
    total: 3,
    failed: 2,
    paused: 0,
    cancelled: 0,
    current: null,
  });
  await open(false, backupStatus({ coverage: { ...status.coverage, offloaded: 3 } }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and remove' }));
  });
  await act(async () => {
    reject(new Error('restore failed'));
  });
  const dialog = screen.getByRole('dialog', { name: 'Remove backup folder "Backup"?' });
  expect(within(dialog).getByText('1 of 3 originals restored')).toBeTruthy();
  expect(within(dialog).getByText("We couldn't restore 2 originals.")).toBeTruthy();
  expect(
    within(dialog).getByText(
      "Couldn't remove the backup. Check the connection and backup folder, then retry.",
    ),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole('button', { name: 'Fetch and remove' }).matches(':disabled'),
  ).toBe(false);
});

test('failed restoration keeps the persisted restore counts when live progress has ended', async () => {
  backupApi.fetchBackProgress = async () => null;
  backupApi.remove = async () => {
    serverStatus = backupStatus({
      coverage: { ...status.coverage, offloaded: 2 },
      last_restore_report: backupReport({
        operation: 'restore',
        outcome: 'partial',
        restored: 1,
        issues: { total: 2, counts: [{ code: 'backup_missing', count: 2 }], samples: [] },
      }),
    });
    throw new Error('restore failed');
  };
  await open(false, backupStatus({ coverage: { ...status.coverage, offloaded: 3 } }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fetch and remove' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Remove backup folder "Backup"?' });
  expect(
    within(dialog)
      .getAllByText('Restored 1 original.')
      .some((element) => element.closest('details') == null),
  ).toBe(true);
  expect(within(dialog).getByText("We couldn't restore 2 originals.")).toBeTruthy();
});

test('historical backup issues do not become the current status', async () => {
  await open(
    false,
    backupStatus({
      last_backup_report: backupReport({
        outcome: 'partial',
        issues: { total: 1, counts: [{ code: 'path_conflict', count: 1 }], samples: [] },
      }),
    }),
    true,
  );
  expect(screen.getAllByText('No originals are waiting to back up.')).toHaveLength(2);
  expect(screen.queryByText(/^Current backup issues/)).toBeNull();
  expect(screen.getByText('Last backup report')).toBeTruthy();
});

test('removing a backup with lost copies warns even when no healthy originals are offloaded', async () => {
  await open(
    false,
    backupStatus({
      status: 'attention',
      coverage: { ...status.coverage, offloaded: 0, missing: 2, missing_originals: 2 },
    }),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Remove backup folder "Backup"?' });
  expect(
    within(dialog).getByText(
      "We couldn't find 2 originals on this device or this backup. Removing the backup doesn't restore them. Look for another copy before removing it.",
    ),
  ).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Remove without fetching' })).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Fetch and remove' })).toBeNull();
});

function ReadBackup(): null {
  const { backup } = usePresenters();
  useEffect(() => {
    void backup.load();
    return () => backup.dispose();
  }, [backup]);
  return null;
}

test('a failed backup status load shows Retry without suggesting a new folder', async () => {
  backupApi.list = async () => {
    throw new Error('offline');
  };
  render(
    <StoresProvider>
      <ReadBackup />
      <BackupPanel library={library(false)} />
    </StoresProvider>,
  );
  await act(async () => {});
  expect(
    screen.getByText("We couldn't read the backup status. Retry to check the backup."),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull();
});

test('the backup keeps its last checked count, local storage and folder visible', async () => {
  await open(false);

  expect(screen.getByText('12 of 12 originals were last recorded on this backup.')).toBeTruthy();
  expect(screen.getByText('This device uses 3.0 GB for originals.')).toBeTruthy();
  expect(screen.getByText('/backup')).toBeTruthy();
});

test.each(['web', 'desktop'])(
  'backup folder selection uses the shared %s chooser directly',
  async (platform) => {
    const calls: { libraryId: string; path: string }[] = [];
    const commands: string[] = [];
    backupApi.setFolder = async (libraryId, path) => {
      calls.push({ libraryId, path });
      serverStatus = { ...status, path };
      return serverStatus;
    };
    browseApi.get = async (path) => ({
      path: path ?? '/home/reader',
      parent: null,
      directories: [],
      writable: true,
    });
    if (platform === 'desktop') {
      Object.defineProperty(globalThis, '__TAURI__', {
        configurable: true,
        value: {
          core: {
            invoke: async (command: string) => {
              commands.push(command);
              return { kind: 'picked', path: '/backups' };
            },
          },
        },
      });
    }
    render(
      <StoresProvider>
        <Seed seeded={{ library_id: 'lib', configured: false }} />
        <BackupPanel library={library(false)} />
      </StoresProvider>,
    );

    expect(screen.queryByRole('textbox')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    });
    if (platform === 'web') {
      const dialog = screen.getByRole('dialog', { name: 'Choose folder' });
      expect(calls).toEqual([]);
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '/backups' } });
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
      });
    }

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls).toEqual([{ libraryId: 'lib', path: '/backups' }]);
    expect(commands).toEqual(platform === 'desktop' ? ['pick_export_folder'] : []);

    backupApi.remove = async () => {
      serverStatus = { library_id: 'lib', configured: false };
    };
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
    });
    const removeDialog = screen.getByRole('dialog', { name: 'Remove backup folder "Backup"?' });
    await act(async () => {
      fireEvent.click(within(removeDialog).getByRole('button', { name: 'Remove backup' }));
    });
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeTruthy();
    expect(calls).toEqual([{ libraryId: 'lib', path: '/backups' }]);
  },
);

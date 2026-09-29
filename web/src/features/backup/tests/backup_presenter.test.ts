import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction, when } from 'mobx';
import type { BackupStatus } from '../../../../../src/schemas/backup';
import type { Transfer } from '../../../../../src/schemas/blobs';
import { backupApi } from '../../../api/backup';
import { blobsApi } from '../../../api/blobs';
import { restoreApiAfterTests } from '../../../test_api';
import { BackupPresenter } from '../backup_presenter';
import { BackupStore } from '../backup_store';
import { backupReport, backupStatus } from './backup_fixture';

restoreApiAfterTests();
const presenters: BackupPresenter[] = [];
afterEach(() => presenters.splice(0).forEach((presenter) => presenter.dispose()));
let server: BackupStatus = backupStatus();
beforeEach(() => {
  server = backupStatus();
  backupApi.list = async () => ({ backups: [server] });
  backupApi.run = async () => ({ status: server, report: backupReport() });
});

function harness(): {
  store: BackupStore;
  presenter: BackupPresenter;
  success: string[];
  errors: string[];
  reloads: () => number;
} {
  const store = new BackupStore();
  const success: string[] = [];
  const errors: string[] = [];
  let reloads = 0;
  const presenter = new BackupPresenter(
    store,
    {
      reload: async () => {
        reloads++;
      },
    },
    {
      show: (message) => success.push(message),
      showError: (message) => errors.push(message),
    },
  );
  presenters.push(presenter);
  runInAction(() => {
    store.byLibrary = new Map([['lib', server]]);
  });
  return { store, presenter, success, errors, reloads: () => reloads };
}

test.each(['partial', 'blocked'] as const)(
  'a %s report cannot produce a success toast with zero counts',
  async (outcome) => {
    const { store, presenter, success, errors } = harness();
    server = backupStatus({ status: 'attention' });
    backupApi.run = async () => ({ status: server, report: backupReport({ outcome }) });
    await presenter.runNow('lib');
    expect(success).toEqual([]);
    expect(errors).toEqual([
      outcome === 'partial'
        ? 'The backup completed with unresolved issues.'
        : "The backup couldn't complete.",
    ]);
    expect(store.statusOf('lib')).toEqual(server);
  },
);

test.each(['waiting', 'paused', 'unavailable', 'working'] as const)(
  'a complete response still shows %s without a success toast',
  async (status) => {
    const { presenter, success, errors } = harness();
    server = backupStatus({ status });
    await presenter.runNow('lib');
    expect(success).toEqual([]);
    expect(errors).toEqual(['The backup still has work remaining.']);
  },
);

test('a run without a configured target is blocked in the UI', async () => {
  const { presenter, success, errors } = harness();
  server = { library_id: 'lib', configured: false };
  backupApi.run = async () => ({ status: server, report: backupReport({ outcome: 'blocked' }) });
  await presenter.runNow('lib');
  expect(success).toEqual([]);
  expect(errors).toEqual(["The backup couldn't complete."]);
});

test('a run on one library leaves another library free to change its backup', async () => {
  const { store, presenter } = harness();
  const released = Promise.withResolvers<void>();
  backupApi.run = async () => {
    await released.promise;
    return { status: server, report: backupReport() };
  };
  let budgets: string[] = [];
  backupApi.setBudget = async (libraryId) => {
    budgets = [...budgets, libraryId];
    return backupStatus({ library_id: libraryId });
  };
  const running = presenter.runNow('lib');
  expect(store.busy('lib')).toBe(true);
  expect(store.busy('other')).toBe(false);
  await presenter.setBudget('other', 1000);
  await presenter.setBudget('lib', 1000);
  expect(budgets).toEqual(['other']);
  released.resolve();
  await running;
  expect(store.busy('lib')).toBe(false);
});

test('a completed run reports confirmed originals and refreshes changed local availability', async () => {
  const { presenter, success, reloads } = harness();
  backupApi.run = async () => ({
    status: server,
    report: backupReport({ copied: 3, offloaded: 2 }),
  });
  await presenter.runNow('lib');
  expect(success).toEqual(['Backed up 3 originals and removed 2 checked local copies.']);
  expect(reloads()).toBe(1);
});

test('failed restoration preserves the configured backup and returns false', async () => {
  const { store, presenter, reloads } = harness();
  backupApi.remove = async () => {
    throw new Error('restore failed');
  };
  backupApi.fetchBackProgress = async () => ({
    done: 1,
    total: 3,
    failed: 2,
    paused: 0,
    cancelled: 0,
    current: null,
  });
  expect(await presenter.remove('lib', true)).toBe(false);
  expect(store.statusOf('lib')).toEqual(server);
  expect(store.errorsByLibrary.get('lib')).toBe(
    "Couldn't remove the backup. Check the connection and backup folder, then retry.",
  );
  expect(store.fetchingBack).toBeNull();
  expect(reloads()).toBe(1);
});

test('resume only resumes paused transfers for this library and its configured backup', async () => {
  server = backupStatus({
    status: 'paused',
    transfers: { queued: 0, active: 0, paused: 1, failed: 0, cancelled: 0 },
  });
  const { presenter } = harness();
  const transfer = (id: string, overrides: Partial<Transfer> = {}): Transfer => ({
    id,
    library_id: 'lib',
    photo_id: 'photo',
    peer_id: 'backup',
    direction: 'push',
    state: 'paused',
    bytes_done: 0,
    bytes_total: 100,
    error: null,
    error_code: null,
    ...overrides,
  });
  blobsApi.listTransfers = async () => [
    transfer('backup'),
    transfer('device', { peer_id: 'device' }),
    transfer('other-library', { library_id: 'other' }),
    transfer('failed', { state: 'failed' }),
  ];
  const resumed: string[] = [];
  blobsApi.resumeTransfer = async (id) => {
    resumed.push(id);
  };
  await presenter.runNow('lib', true);
  expect(resumed).toEqual(['backup']);
});

test('backup event bursts coalesce into one authoritative read', async () => {
  const { store, presenter, success, errors } = harness();
  let reads = 0;
  server = backupStatus({ status: 'attention' });
  backupApi.list = async () => {
    reads++;
    return { backups: [server] };
  };
  for (let i = 0; i < 20; i++) presenter.refresh();
  await when(() => store.statusOf('lib') === server, { timeout: 1000 });
  expect(reads).toBe(1);
  expect(success).toEqual([]);
  expect(errors).toEqual([]);
});

test('a read begun before a folder change cannot overwrite the new folder', async () => {
  const { store, presenter } = harness();
  let finish: (statuses: { backups: BackupStatus[] }) => void = () => {};
  const old = backupStatus();
  let reads = 0;
  backupApi.list = () =>
    ++reads === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ backups: [server] });
  backupApi.setFolder = async () => {
    server = backupStatus({ path: '/new-backup' });
    return server;
  };
  const reading = presenter.load();
  await Promise.resolve();
  const setting = presenter.setFolder('lib', '/new-backup');
  await Promise.resolve();
  finish({ backups: [old] });
  await Promise.all([setting, reading]);
  expect(store.statusOf('lib')).toEqual(server);
  await when(() => store.statusOf('lib') === server && reads === 2, { timeout: 1000 });
  expect(store.statusOf('lib')).toEqual(server);
});

test('failed initial reads stay visible and a later read clears the error', async () => {
  const { store, presenter } = harness();
  backupApi.list = async () => {
    throw new Error('offline');
  };
  await presenter.load();
  expect(store.readError).toBe("We couldn't read the backup status. Retry to check the backup.");
  expect(store.loaded).toBe(false);
  backupApi.list = async () => ({ backups: [server] });
  await presenter.load();
  expect(store.readError).toBeNull();
  expect(store.loaded).toBe(true);
});

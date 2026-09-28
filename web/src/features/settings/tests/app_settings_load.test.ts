import { expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, type Settings } from '../../../../../src/schemas/settings';
import { settingsApi } from '../../../api/settings';
import { AppSettingsPresenter } from '../app_settings_presenter';
import { AppSettingsStore } from '../app_settings_store';
import { restoreApiAfterTests } from '../../../test_api';

restoreApiAfterTests();

settingsApi.getDefaults = (): Promise<Settings> => Promise.resolve(DEFAULT_SETTINGS);

function build(): { store: AppSettingsStore; presenter: AppSettingsPresenter } {
  const store = new AppSettingsStore();
  return { store, presenter: new AppSettingsPresenter(store, { showError: () => {} } as never) };
}

test('a load that fails stops loading with no settings', async () => {
  settingsApi.get = () => Promise.reject(new Error('offline'));
  const { store, presenter } = build();
  await presenter.load();
  expect(store.settings).toBeNull();
  expect(store.loading).toBe(false);
});

test('loading holds until the settings land', async () => {
  let land: (settings: Settings) => void = () => {};
  settingsApi.get = () => new Promise((resolve) => (land = resolve));
  const { store, presenter } = build();
  const loaded = presenter.load();
  expect(store.loading).toBe(true);
  land(DEFAULT_SETTINGS);
  await loaded;
  expect(store.settings).toEqual(DEFAULT_SETTINGS);
  expect(store.loading).toBe(false);
});

test('disk usage loads once while pending and refreshes on the next visit', async () => {
  let land: (usage: { bytes: number }) => void = () => {};
  let requests = 0;
  settingsApi.storageUsage = () => {
    requests++;
    return new Promise((resolve) => (land = resolve));
  };
  const { store, presenter } = build();
  const first = presenter.loadStorageUsage();
  const concurrent = presenter.loadStorageUsage();
  expect(store.storageUsage).toEqual({ kind: 'loading' });
  expect(requests).toBe(1);
  land({ bytes: 1536 });
  await Promise.all([first, concurrent]);
  expect(store.storageUsage).toEqual({ kind: 'ready', bytes: 1536 });

  const refreshed = presenter.loadStorageUsage();
  expect(store.storageUsage).toEqual({ kind: 'loading' });
  expect(requests).toBe(2);
  land({ bytes: 2048 });
  await refreshed;
  expect(store.storageUsage).toEqual({ kind: 'ready', bytes: 2048 });
});

test('disk usage failure can be retried without showing zero', async () => {
  settingsApi.storageUsage = () => Promise.reject(new Error('unreadable'));
  const { store, presenter } = build();
  await presenter.loadStorageUsage();
  expect(store.storageUsage).toEqual({ kind: 'failed' });

  settingsApi.storageUsage = () => Promise.resolve({ bytes: 4096 });
  await presenter.loadStorageUsage();
  expect(store.storageUsage).toEqual({ kind: 'ready', bytes: 4096 });
});

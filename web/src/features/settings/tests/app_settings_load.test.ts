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

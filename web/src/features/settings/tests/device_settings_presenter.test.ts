import { beforeEach, expect, test } from 'bun:test';
import { ScreenStore } from '../../../app/screen_store';
import { MemoryStorage } from '../../../test_storage';
import { DeviceSettingsPresenter } from '../device_settings_presenter';
import { DeviceSettingsStore } from '../device_settings_store';

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

test('a closed quality notice stays closed on this device, and only where it was closed', () => {
  const store = new DeviceSettingsStore(new ScreenStore());
  new DeviceSettingsPresenter(store).closeQualityNotice('viewer');
  expect(store.viewerQualityNoticeClosed).toBe(true);

  const reopened = new DeviceSettingsStore(new ScreenStore());
  new DeviceSettingsPresenter(reopened);
  expect(reopened.viewerQualityNoticeClosed).toBe(true);
  expect(reopened.editorQualityNoticeClosed).toBe(false);
});

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

test("gives the shell's stage no headroom on a screen that shows nothing past SDR white", () => {
  const store = new DeviceSettingsStore(new ScreenStore());
  store.screen.reading = { hdr: false, measures: false, headroom: null, potential: null };
  expect(store.stageHeadroom).toBeNull();
});

test("lights the shell's stage at the HDR white calibrated, until Android measures the screen", () => {
  const store = new DeviceSettingsStore(new ScreenStore());
  const presenter = new DeviceSettingsPresenter(store);
  store.screen.reading = { hdr: true, measures: false, headroom: null, potential: null };
  expect(store.stageWhite).toBe(6);
  presenter.setHdrWhite(3.125);
  presenter.setHdrWhite(0);
  expect(store.stageWhite).toBe(3.125);
  expect(store.stageHeadroom).toBe(4);
  presenter.setDisplayPeakNits(200);
  expect(store.stageHeadroom).toBe(1);

  const reopened = new DeviceSettingsStore(new ScreenStore());
  new DeviceSettingsPresenter(reopened);
  expect(reopened.hdrWhite).toBe(3.125);
  reopened.screen.reading = { hdr: true, measures: true, headroom: 4, potential: null };
  expect(reopened.stageWhite).toBe(1);
  expect(reopened.stageHeadroom).toBe(4);
});

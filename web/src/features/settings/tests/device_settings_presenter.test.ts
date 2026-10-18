import { beforeEach, expect, test } from 'bun:test';
import { ScreenStore } from '../../../app/screen_store';
import { MemoryStorage } from '../../../test_storage';
import { DeviceSettingsPresenter, steppedHdrWhite } from '../device_settings_presenter';
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

test('steps the HDR white in exact tenths, within the range a saved one is restored from', () => {
  let white = 6;
  for (let i = 0; i < 7; i++) white = steppedHdrWhite(white, 1);
  for (let i = 0; i < 3; i++) white = steppedHdrWhite(white, -1);
  expect(white).toBe(6.4);
  expect(steppedHdrWhite(1, -1)).toBe(1);
  expect(steppedHdrWhite(50, 1)).toBe(50);

  localStorage.setItem('bowerbird.hdrWhite', '1e9');
  const store = new DeviceSettingsStore(new ScreenStore());
  new DeviceSettingsPresenter(store);
  expect(store.hdrWhite).toBe(6);
});

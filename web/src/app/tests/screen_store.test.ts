import { expect, test } from 'bun:test';
import type { DynamicRange } from '../../api/transport';
import { DeviceSettingsStore } from '../../features/settings/device_settings_store';
import { ScreenPresenter } from '../screen_presenter';
import { ScreenStore } from '../screen_store';

const CONFIGURED = 800;

function device(): DeviceSettingsStore {
  const settings = new DeviceSettingsStore(new ScreenStore());
  settings.displayPeakNits = CONFIGURED;
  return settings;
}

function read(settings: DeviceSettingsStore, reading: Partial<DynamicRange> | null): Promise<void> {
  const range =
    reading == null
      ? null
      : { hdr: true, measures: false, headroom: null, potential: null, peak: null, ...reading };
  return new ScreenPresenter(settings.screen, async () => range).ask();
}

test("rolls off to the screen's headroom, rounded down to an eighth of a stop", async () => {
  const settings = device();
  await read(settings, { measures: true, headroom: 3.3, potential: 16 });
  expect(settings.peakNits).toBeCloseTo(626.14, 1);
  expect(settings.screen.potentialNits).toBe(3248);
});

test('follows the headroom as it moves', async () => {
  const settings = device();
  await read(settings, { measures: true, headroom: 4 });
  expect(settings.peakNits).toBe(812);
  await read(settings, { measures: true, headroom: 8 });
  expect(settings.peakNits).toBe(1624);
});

test('draws nothing past SDR white on an HDR screen whose peak is SDR white', async () => {
  const settings = device();
  await read(settings, { measures: true, headroom: 1 });
  expect(settings.peakNits).toBe(203);
});

test('uses the configured peak until the screen opens its headroom, with the setting hidden', async () => {
  const settings = device();
  await read(settings, { measures: true, headroom: null, potential: 16 });
  expect(settings.peakNits).toBe(CONFIGURED);
  expect(settings.screen.measures).toBe(true);
});

test('uses the configured peak where the shell cannot read the screen, with the setting shown', async () => {
  const settings = device();
  await read(settings, { measures: false });
  expect(settings.peakNits).toBe(CONFIGURED);
  expect(settings.screen.measures).toBe(false);
});

test('has no peak on a screen that shows nothing past SDR white, whatever the media query says', async () => {
  const settings = device();
  settings.screen.mediaHdr = true;
  await read(settings, { hdr: false, measures: true, headroom: 1 });
  expect(settings.peakNits).toBeNull();
});

test('falls back to the media query in a browser', async () => {
  const settings = device();
  await read(settings, null);
  expect(settings.peakNits).toBeNull();
  settings.screen.mediaHdr = true;
  expect(settings.peakNits).toBe(CONFIGURED);
});

test("takes Firefox's HDR video answer without giving its canvases a peak", async () => {
  const settings = device();
  const realMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = ((query: string) => ({
    matches: query === '(video-dynamic-range: high)',
    addEventListener: () => undefined,
  })) as unknown as typeof matchMedia;
  try {
    await new ScreenPresenter(settings.screen, null).follow();
  } finally {
    globalThis.matchMedia = realMatchMedia;
  }
  expect(settings.screen.videoHdr).toBe(true);
  expect(settings.screen.hdr).toBe(false);
  expect(settings.peakNits).toBeNull();
});

test('lets a slow answer land without asking over it', async () => {
  const settings = device();
  const answer = Promise.withResolvers<DynamicRange>();
  let asked = 0;
  const presenter = new ScreenPresenter(settings.screen, () => {
    asked++;
    return answer.promise;
  });
  const first = presenter.ask();
  await presenter.ask();
  answer.resolve({ hdr: true, measures: true, headroom: 2, potential: null, peak: null });
  await first;
  expect(asked).toBe(1);
  expect(settings.peakNits).toBe(406);
});

test('keeps the last reading when the shell fails to answer', async () => {
  const settings = device();
  await read(settings, { measures: true, headroom: 2 });
  await new ScreenPresenter(settings.screen, () => Promise.reject(new Error('gone'))).ask();
  expect(settings.peakNits).toBe(406);
});

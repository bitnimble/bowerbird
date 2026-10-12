import { afterEach, expect, test } from 'bun:test';
import type { DynamicRange } from '../../api/transport';
import { ScreenPresenter } from '../../app/screen_presenter';
import { screenStore } from '../../app/screen_store';
import { drawsOnThePage, transferredPeakNits } from '../readback_canvas';

const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const ownAgent = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent');

function browsing(agent: string): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: agent, configurable: true });
}

function screen(reading: DynamicRange | null): Promise<void> {
  return new ScreenPresenter(screenStore, async () => reading).ask();
}

afterEach(async () => {
  if (ownAgent == null) Reflect.deleteProperty(globalThis.navigator, 'userAgent');
  else Object.defineProperty(globalThis.navigator, 'userAgent', ownAgent);
  await screen(null);
});

test('WebKit keeps a canvas on the page where the screen can open past what a transferred one shows', async () => {
  browsing(SAFARI);
  await screen({ hdr: true, measures: true, headroom: null, potential: 16 });
  expect(drawsOnThePage(800)).toBe(true);
});

test('WebKit transfers a canvas on a screen that never passes that', async () => {
  browsing(SAFARI);
  await screen({ hdr: true, measures: true, headroom: 2, potential: 4 });
  expect(drawsOnThePage(812)).toBe(false);
  expect(drawsOnThePage(null)).toBe(false);
});

test('WebKit keeps a canvas on the page for a configured peak past that, in a browser', () => {
  browsing(SAFARI);
  expect(drawsOnThePage(1600)).toBe(true);
  expect(drawsOnThePage(1000)).toBe(false);
});

test('Chromium always transfers, at the full peak', async () => {
  browsing(CHROME);
  await screen({ hdr: true, measures: true, headroom: 8, potential: 16 });
  expect(drawsOnThePage(1624)).toBe(false);
  expect(transferredPeakNits(1624)).toBe(1624);
});

test('WebKit holds a draw onto a transferred canvas to 1000 nits', () => {
  browsing(SAFARI);
  expect(transferredPeakNits(1624)).toBe(1000);
  expect(transferredPeakNits(812)).toBe(812);
  expect(transferredPeakNits(null)).toBeNull();
});

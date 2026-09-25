// Viewing a photograph does not require WebGPU.
//
// The editor may - it runs the pipeline's own shaders, and a second implementation of those is
// the one thing this repo is built not to have - but reading a library is not editing one, and
// a machine with no adapter still has to show the picture. The stage draws through an ordinary
// 2D context there, where the browser tone maps an HDR rendition on the way in rather than
// clipping it.
//
// Only a real browser can answer this: what a canvas does with no adapter is the browser's
// behaviour, not the app's.
import { expect, test } from '@playwright/test';
import { FALLBACK_PHOTOS_DIR } from '../fixture_library';
import { gotoPhoto, shownFrame, useLibrary } from '../helpers';

// `launchOptions` replaces the config's rather than merging with it, so the args that make a
// browser start at all here have to be repeated - minus the ones that turn WebGPU on, which is
// the whole point of the file.
test.use({
  launchOptions: {
    args: ['--no-sandbox', '--ozone-platform=headless', '--disable-features=WebGPU,WebGPUExperimentalFeatures'],
  },
});

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, FALLBACK_PHOTOS_DIR, { viewerRendition: 'embedded' });
});

test('a photograph is shown on a machine with no WebGPU adapter', async ({ page }) => {
  await gotoPhoto(page, FALLBACK_PHOTOS_DIR);

  // Refused rather than merely absent: `navigator.gpu` is still there with the feature off,
  // and it is the adapter that does not arrive. If this ever comes back true the rest of the
  // test proves nothing, because the GPU path would be the one under it.
  const adapter = await page.evaluate(async () => {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return gpu == null ? null : await gpu.requestAdapter().catch(() => null);
  });
  expect(adapter, 'this browser was launched without WebGPU').toBeNull();

  const shown = shownFrame(page);
  await expect(shown).toBeVisible({ timeout: 60_000 });

  // Drawn, not merely mounted. A canvas configured for WebGPU can give no 2D context, and
  // `drawImage` on a null one silently does nothing - which leaves exactly this element in
  // exactly this state, blank.
  const lit = await shown.evaluate((frame: HTMLCanvasElement) => {
    const probe = document.createElement('canvas');
    probe.width = 16;
    probe.height = 16;
    const context = probe.getContext('2d');
    if (context == null) return -1;
    context.drawImage(frame, 0, 0, 16, 16);
    const { data } = context.getImageData(0, 0, 16, 16);
    let seen = 0;
    for (let at = 0; at < data.length; at += 4) {
      if (data[at + 3]! > 0 && data[at]! + data[at + 1]! + data[at + 2]! > 12) seen++;
    }
    return seen;
  });
  expect(lit, 'the canvas has a picture on it').toBeGreaterThan(200);
});

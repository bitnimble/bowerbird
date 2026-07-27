import { expect, test } from '@playwright/test';
import { NATIVE_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, syncLibrary, viewOriginal } from './helpers';

// Chrome 145+ decodes JPEG XL behind chrome://flags/#enable-jxl-image-format,
// which is this feature switch. It has to be top-level: launchOptions force a
// separate worker, so this cannot live alongside the wasm-path test.
test.use({ launchOptions: { args: ['--enable-features=JXLImageFormat'] } });

test.describe.configure({ mode: 'serial' });

test('sync indexes the native-decode library', async ({ page }) => {
  await addLibrary(page, NATIVE_PHOTOS_DIR);
  await syncLibrary(page, NATIVE_PHOTOS_DIR);
  await openLibrary(page, NATIVE_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });
});

test('View original hands the .jxl straight to the img and never loads the wasm', async ({ page }) => {
  // A preview decode plus a from-scratch full-resolution render, both on the
  // real RAW: past the 60s the other specs need.
  test.setTimeout(240_000);
  const wasmRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.wasm')) wasmRequests.push(r.url());
  });

  await viewOriginal(page, NATIVE_PHOTOS_DIR);

  const shown = page.locator('.stage__viewport img');
  expect(await shown.evaluate((i: HTMLImageElement) => i.src)).toContain('/lossless.jxl');
  // Full resolution, not the 3840-edge preview it replaced.
  expect(await shown.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(3840);
  // The point of the native path: a browser that decodes JXL itself must not
  // pay for the 1.6MB decoder.
  expect(wasmRequests).toEqual([]);
});

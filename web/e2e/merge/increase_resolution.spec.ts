// Increase resolution from the bulk bar: the same merge as Reduce noise onto a grid twice as fine.
// The frames are smaller than the photo viewer's rendition, so opening it merges at 2x. The size
// is the server's (`composites_service.test.ts`), the picture native's (`burst_scene`).
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { MERGE_PHOTO_NAMES, RESOLUTION_PHOTOS_DIR } from '../fixture_library';
import { frames, gotoLibrary, photoStage, selectPhoto, tiles, useLibrary } from '../helpers';

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, RESOLUTION_PHOTOS_DIR, { photos: MERGE_PHOTO_NAMES.length });
});

test('a burst merges into 1 photo at twice the resolution that opens', async ({ page }) => {
  await gotoLibrary(page, RESOLUTION_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(MERGE_PHOTO_NAMES.length);
  for (let frame = 0; frame < MERGE_PHOTO_NAMES.length; frame += 1) {
    await selectPhoto(page, frame);
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge photos', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Increase resolution', exact: true }).click();

  await expect(tiles(page)).toHaveCount(1, { timeout: 240_000 });
  await frames(page).click();
  await expect(photoStage(page)).toBeVisible({ timeout: 120_000 });
});

// Reduce noise from the bulk bar: the frames are aligned, merged on the mosaic and rendered before
// the call answers, so a tile standing for all of them is a merge a real device made. What the
// picture looks like is native's (`burst_scene`).
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { BURST_PHOTOS_DIR, MERGE_PHOTO_NAMES } from '../fixture_library';
import { frames, gotoLibrary, photoStage, selectPhoto, tiles, useLibrary } from '../helpers';

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, BURST_PHOTOS_DIR, { photos: MERGE_PHOTO_NAMES.length });
});

test('a burst merges into 1 photo that opens', async ({ page }) => {
  await gotoLibrary(page, BURST_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(MERGE_PHOTO_NAMES.length);
  for (let frame = 0; frame < MERGE_PHOTO_NAMES.length; frame += 1) {
    await selectPhoto(page, frame);
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge photos', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reduce noise', exact: true }).click();

  await expect(tiles(page)).toHaveCount(1, { timeout: 240_000 });
  const merged = frames(page);
  await expect(merged).toHaveAccessibleName(
    new RegExp(`merge of ${MERGE_PHOTO_NAMES.length} photos`),
  );
  await merged.click();
  await expect(photoStage(page)).toBeVisible({ timeout: 120_000 });
});

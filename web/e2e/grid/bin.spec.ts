// Soft delete and what comes back from it: the keystroke, the toast that undoes
// it, and the Bin's own restore.
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { BIN_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import {
  bulkAction,
  cursorTile,
  gallery,
  gotoLibrary,
  sidebarSection,
  selectPhoto,
  tileName,
  tiles,
  useLibrary,
} from '../helpers';

// In order, and each counts the library it is handed.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, BIN_PHOTOS_DIR);
});

test('Delete bins the focused photo and the toast undoes it', async ({ page }) => {
  await gotoLibrary(page, BIN_PHOTOS_DIR);
  // Wait for the grid: a keypress before the photos land finds nothing to focus.
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  await page.keyboard.press('ArrowRight');
  await expect(cursorTile(page)).toHaveCount(1);
  const binned = await tileName(tiles(page).first());
  await page.keyboard.press('Delete');

  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length - 1);
  await expect(page.getByText('Moved 1 photo to the Bin.')).toBeVisible();

  // Undo must actually put it back, not just dismiss the toast.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  await expect(gallery(page).getByText(binned, { exact: true })).toBeVisible();
});

test('the Bin holds only the binned photo, and restoring returns it to the library', async ({ page }) => {
  await gotoLibrary(page, BIN_PHOTOS_DIR);

  await selectPhoto(page);
  await bulkAction(page, 'Move to Bin');
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length - 1);

  // Regression: include_deleted alone returns live + deleted, so the Bin showed
  // the whole library. It needs the is_deleted filter to mean "only the Bin".
  await sidebarSection(page, BIN_PHOTOS_DIR, 'Bin').click();
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).getByText('in Bin', { exact: true })).toHaveCount(1);
  // Regression: the Bin used to hold rendition-less grey boxes because
  // soft-delete removed the WebPs, making it impossible to find anything.
  await expect(gallery(page).locator('[role="listitem"][aria-busy="true"]')).toHaveCount(0);

  // Regression: the Bin used to offer add-to-shoot, which always failed with
  // "photos not found" because deleted rows are excluded from that lookup. Every
  // action but the restore lives behind the overflow, so the Bin offers no
  // overflow at all.
  await selectPhoto(page);
  await expect(page.getByRole('button', { name: 'More actions' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Restore to original location' }).click();
  await expect(tiles(page)).toHaveCount(0);

  await sidebarSection(page, BIN_PHOTOS_DIR, 'Photos').click();
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
});

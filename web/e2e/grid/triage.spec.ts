// Judging photographs from the grid: the verdict and the rating on a tile, and
// what the working set does when one is rejected. The whole point of these
// controls is that a cull never has to go through the detail view, so nothing
// here opens a photo.
import { expect, test, type Locator } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { GRID_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import { cursorTile, gotoLibrary, tiles, useLibrary } from '../helpers';

const picked = (scope: Locator) => scope.getByRole('button', { name: 'Clear Pick', pressed: true });
const stars = (scope: Locator) => scope.getByRole('group', { name: 'Rating' }).getByRole('button', { pressed: true });

// In order: each of these leaves a verdict on a tile, and the next one reads the
// grid around it.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, GRID_PHOTOS_DIR);
});

test('rating and picking work from the grid without opening a photo', async ({ page }) => {
  await gotoLibrary(page, GRID_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  // Arrow to the first tile, rate it, pick it. The whole point is that culling
  // never requires a round trip through the detail view.
  await page.keyboard.press('ArrowRight');
  await expect(cursorTile(page)).toHaveCount(1);
  await page.keyboard.press('4');
  await page.keyboard.press('c');

  const first = tiles(page).first();
  await expect(picked(first)).toBeVisible();
  await expect(stars(first)).toHaveCount(4);

  // The verdict survives a reload, so it was persisted rather than only shown.
  await page.reload();
  await expect(stars(first)).toHaveCount(4);
  await expect(picked(first)).toBeVisible();
});

test('the verdict and rating on a tile are clickable, and clicking again clears them', async ({ page }) => {
  await gotoLibrary(page, GRID_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  const tile = tiles(page).nth(1);

  // Setting a verdict from the grid must not open the photo: these controls are
  // the whole reason a cull does not need the detail view.
  await tile.getByRole('button', { name: 'Pick' }).click();
  await expect(picked(tile)).toBeVisible();
  expect(page.url()).not.toContain(`${route(PathSegment.photos())}/`);

  await tile.getByRole('button', { name: 'Clear pick' }).click();
  await expect(picked(tile)).toHaveCount(0);

  // The pointer is moved off the stars before each count: resting on one draws the run
  // up to it as a preview of what a click would set, which is not the rating.
  await tile.getByRole('button', { name: 'Set rating to 3' }).click();
  await page.mouse.move(0, 0);
  await expect(stars(tile)).toHaveCount(3);
  // Clicking the star it already sits on is how a rating is removed.
  await tile.getByRole('button', { name: 'Set rating to 3' }).click();
  await page.mouse.move(0, 0);
  await expect(stars(tile)).toHaveCount(0);
});

test('rejecting removes a photo from the default working set', async ({ page }) => {
  await gotoLibrary(page, GRID_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  // The gallery opens on Active (untriaged + picked), so a reject should leave
  // the view immediately rather than lingering in the set being worked through.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length - 1);

  await page.getByRole('button', { name: 'Rejects', exact: true }).click();
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).getByRole('button', { name: 'Clear Reject', pressed: true })).toHaveCount(1);

  // Pressing it again clears the verdict, which is the other half of the claim:
  // the photograph comes back to the set being worked through.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
});

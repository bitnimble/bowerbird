// A library arriving: the scan that finds the RAWs, the tiles that follow it, and
// the collection settings that outlive the browser they were set in.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { INDEX_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import { forgetLibrary, gallery, gotoLibrary, openLibrary, tiles } from '../helpers';

// In order: the first test is what puts the library here, and the second reads it.
test.describe.configure({ mode: 'serial' });

function libraryRow(page: Page, rootPath: string): Locator {
  return page.getByRole('list', { name: 'Libraries' }).getByRole('listitem').filter({ hasText: rootPath });
}

// The one spec that adds a library and scans it the way a reader does; every other root is
// added through the API.
test('a library added and scanned in Settings shows a rendition for every RAW file', async ({ page }) => {
  await forgetLibrary(page, INDEX_PHOTOS_DIR);
  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();
  // The picker writes the folder it opened at into this box, so a path typed
  // before that lands would be overwritten by it.
  const dialog = page.getByRole('dialog', { name: 'Add library' });
  const path = dialog.getByLabel('Library root');
  await expect(path).not.toHaveValue('');
  await path.fill(INDEX_PHOTOS_DIR);
  // The camera's JPEG rather than the default render, which is minutes of work per frame, and
  // no stacking, which would collapse the fixture's identical frames into one tile.
  await dialog.getByRole('combobox', { name: 'Build renditions from' }).click();
  await page.getByRole('option', { name: 'Embedded JPEG' }).click();
  await dialog.getByRole('checkbox', { name: 'Group similar photos automatically' }).uncheck();
  // The dialog's own button carries the same name as the one that opened it.
  await dialog.getByRole('button', { name: 'Add library' }).click();
  // Creating a library walks the folder before the row can be re-read.
  await expect(libraryRow(page, INDEX_PHOTOS_DIR)).toBeVisible({ timeout: 30_000 });

  await libraryRow(page, INDEX_PHOTOS_DIR).getByRole('button', { name: 'Scan library' }).click();
  await openLibrary(page, INDEX_PHOTOS_DIR);
  // The import the add started, which opens every file.
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });

  // Regression: renditions are requested before processing has written them, so
  // the first request 404s, and the tile has nothing to do but wait for the
  // server to say its photo is built. Every tile must end up showing decoded
  // pixels, and none may be left on the placeholder.
  await expect
    .poll(
      async () =>
        tiles(page)
          .locator('img')
          .evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length),
      { timeout: 45_000 },
    )
    .toBe(PHOTO_NAMES.length);
  await expect(gallery(page).locator('[role="listitem"][aria-busy="true"]')).toHaveCount(0);
});

test('the sort follows the collection rather than the browser it was set in', async ({ page }) => {
  // The point of storing it on the collection: clearing this browser's state is
  // what a second device looks like, and the sort has to survive it. Held in
  // localStorage, as it was, the reload below came back sorted by the default.
  await gotoLibrary(page, INDEX_PHOTOS_DIR);
  // The control is an icon, so what it is showing is in its name rather than in any text:
  // an `aria-label` replaces content for naming, which leaves the name the only place left.
  const sort = page.getByRole('combobox', { name: 'Sort photos' });
  await expect(sort).toHaveAccessibleName('Sort photos: Oldest first');

  await sort.click();
  await page.getByRole('option', { name: 'Recently added' }).click();
  await expect(sort).toHaveAccessibleName('Sort photos: Recently added');

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(sort).toHaveAccessibleName('Sort photos: Recently added');
});

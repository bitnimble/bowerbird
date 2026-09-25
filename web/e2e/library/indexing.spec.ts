// A library arriving: the scan that finds the RAWs, the tiles that follow it, and
// the collection settings that outlive the browser they were set in.
import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { INDEX_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import { addLibrary, gallery, libraryRow, openLibrary, tiles } from '../helpers';

// In order: the first test is what puts the library here, and the second reads it.
test.describe.configure({ mode: 'serial' });

test('indexes a library, scans it again, and shows a rendition for every RAW file', async ({ page }) => {
  await addLibrary(page, INDEX_PHOTOS_DIR);
  // The one spec that asks for a scan the way a reader does; every other root is imported by
  // being added.
  await page.goto(route(PathSegment.settings()));
  await libraryRow(page, INDEX_PHOTOS_DIR).getByRole('button', { name: 'Scan library' }).click();
  await openLibrary(page, INDEX_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

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
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, INDEX_PHOTOS_DIR);
  // The control is an icon, so what it is showing is in its name rather than in any text:
  // an `aria-label` replaces content for naming, which leaves the name the only place left.
  const sort = page.getByRole('combobox', { name: 'Sort photos' });
  await expect(sort).toHaveAccessibleName('Sort photos: Oldest first');

  await sort.click();
  await page.getByRole('option', { name: 'Recently added' }).click();
  await expect(sort).toHaveAccessibleName('Sort photos: Recently added');

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openLibrary(page, INDEX_PHOTOS_DIR);
  await expect(sort).toHaveAccessibleName('Sort photos: Recently added');
});

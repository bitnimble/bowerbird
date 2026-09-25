// What the address bar carries for a grid, and what it must not carry into the
// next one. Here because only a browser can answer a reload.
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PHOTO_NAMES, URL_OTHER_PHOTOS_DIR, URL_PHOTOS_DIR, URL_PHOTO_NAMES } from '../fixture_library';
import { addLibrary, gallery, gotoLibrary, openLibrary, tiles } from '../helpers';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  for (const [root, names] of [
    [URL_PHOTOS_DIR, URL_PHOTO_NAMES],
    [URL_OTHER_PHOTOS_DIR, PHOTO_NAMES],
  ] as const) {
    await addLibrary(page, root, { photos: names.length });
  }
  await page.close();
});

test('a reload comes back to the photograph the window started on', async ({ page }) => {
  // Narrow enough that masonry packs one frame to a line, so four of them are
  // several windows tall and the end of the scroll is rows past the first.
  await page.setViewportSize({ width: 420, height: 560 });
  await gotoLibrary(page, URL_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(URL_PHOTO_NAMES.length);

  const scroller = gallery(page);
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(() => Number(new URL(page.url()).searchParams.get('at'))).toBeGreaterThan(0);
  const was = await scroller.evaluate((el) => el.scrollTop);
  const row = (await tiles(page).first().boundingBox())!.height;

  await page.reload();
  await expect(tiles(page)).toHaveCount(URL_PHOTO_NAMES.length);

  // Within a row of where they were: the position names a photograph, and where a
  // masonry line put that photograph is not known until the block has laid out.
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(was - row);
});

test('a search survives a reload of the tab, and is not carried into another library or a fresh visit', async ({ page }) => {
  await gotoLibrary(page, URL_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(URL_PHOTO_NAMES.length);
  const library = page.url();

  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByLabel('Find by filename').fill('beta');
  await expect(tiles(page)).toHaveCount(1);
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('beta');

  await page.reload();
  await expect(tiles(page)).toHaveCount(1);

  // The sidebar, so the grid is never unmounted between the two libraries - which is
  // the whole of what this is about: the second library holds a beta.arw of its
  // own, so a search carried over would show one frame of the two.
  await openLibrary(page, URL_OTHER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  expect(new URL(page.url()).searchParams.get('q')).toBeNull();

  // The question belonged to the tab, not to the library: opening it afresh asks
  // nothing. A filter that outlived the visit is one the next reader has to work
  // out they are looking through before they can trust what they are seeing.
  await page.goto(library);
  await expect(tiles(page)).toHaveCount(URL_PHOTO_NAMES.length);
});

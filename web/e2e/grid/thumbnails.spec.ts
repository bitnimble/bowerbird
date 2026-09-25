// The grid tile as a file of its own: rebuilding one from the bulk bar, and the
// two stamps that keep a tile and the viewer's rendition from moving each other.
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHOTO_NAMES, THUMBNAIL_PHOTOS_DIR } from '../fixture_library';
import {
  FIRST_FRAME,
  bulkAction,
  gotoLibrary,
  openPhoto,
  photoIdOfImageUrl,
  renditionDetails,
  selectPhoto,
  setRenditionSource,
  setViewerRendition,
  showMetadata,
  shownFrame,
  tiles,
  useLibrary,
} from '../helpers';

// In order: the last of these re-points the library at a render, which is what
// the first is asserting the absence of.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, THUMBNAIL_PHOTOS_DIR);
});

test("a selection's grid tiles are rebuilt from the bulk bar, and pushed to the tile that changed alone", async ({ page }) => {
  await gotoLibrary(page, THUMBNAIL_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  const src = (index: number): Promise<string | null> => tiles(page).nth(index).locator('img').getAttribute('src');
  const [rebuilt, untouched] = [await src(0), await src(1)];

  await selectPhoto(page);
  await bulkAction(page, 'Rebuild thumbnails');
  // The toast reports the rebuild once it is done, so this waits on a decode.
  await expect(page.getByText(/Queued 1 thumbnail to rebuild/)).toBeVisible(FIRST_FRAME);

  // The server names the photo it just wrote and the tile asks again for that one
  // alone. Nothing here polls, and no version lands on a photo that did not move.
  await expect.poll(() => src(0), { timeout: 60_000 }).not.toBe(rebuilt);
  expect(await src(1)).toBe(untouched);

  // What the viewer is served is recorded per photo and a tile rebuild says
  // nothing about it, so the detail view reads the same afterwards.
  await openPhoto(page);
  await showMetadata(page);
  await expect(renditionDetails(page).getByText('Embedded JPEG')).toBeVisible({ timeout: 30_000 });
});

// The two halves of an import are tracked apart all the way to the browser's
// cache: one stamp each, so a URL only moves when the file behind it did.
test('rebuilding a photo rendition leaves its grid tile where it is', async ({ page }) => {
  test.setTimeout(240_000);
  await setRenditionSource(page, THUMBNAIL_PHOTOS_DIR, 'render');
  // The viewer has to follow the library for the last assertion here, and what it
  // follows by default is whatever rendition was last chosen anywhere.
  await setViewerRendition(page.request, 'full');
  await gotoLibrary(page, THUMBNAIL_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  const tile = tiles(page).first().locator('img');
  const before = await tile.getAttribute('src');
  const photoId = photoIdOfImageUrl(before);
  expect(photoId).not.toBe('');

  // A render of the viewer's copy, which writes no tile. Shared one stamp, this
  // moved every tile URL on the page and re-downloaded bytes that had not changed.
  await page.request.post(
    `${route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.renditions(), 'full')}?force=true`,
    { timeout: 180_000 },
  );
  // Long enough for the announcement to have arrived and been applied.
  await expect.poll(async () => (await tiles(page).nth(1).locator('img').getAttribute('src')) ?? '').not.toBe('');
  await page.waitForTimeout(1000);
  expect(await tile.getAttribute('src')).toBe(before);

  // And the viewer's own URL did move, so the announcement was heard - it is the
  // stage that changed, not the fact of a change, that the tile ignored.
  const versioned = `${route(PathSegment.renditions(), 'full')}?v=`;
  const fetched = page.waitForRequest((request) => request.url().includes(`${photoId}${versioned}`), { timeout: 60_000 });
  await openPhoto(page);
  await fetched;
  await expect(shownFrame(page)).toHaveAccessibleName(/Rendered RAW$/, { timeout: 60_000 });
});

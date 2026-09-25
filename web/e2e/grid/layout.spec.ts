// How the grid arranges what it is given: the masonry view's rows, and what a
// list row paints over its frame. The band a stack opens is `bands.spec.ts`.
import { expect, test } from '@playwright/test';
import { LAYOUT_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import { frames, gallery, gotoLibrary, setViewMode, tileName, tiles, useLibrary } from '../helpers';

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, LAYOUT_PHOTOS_DIR);
});

test('masonry lays photos out across a row, not down a column', async ({ page }) => {
  await gotoLibrary(page, LAYOUT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  await setViewMode(page, 'Masonry');

  // Regression: laid out with CSS columns, the tiles ran down the first column
  // before starting the second, which a paged or infinite list cannot do - it
  // has no bottom to fill to. They now sit on a row of one height, which is the
  // zoom size: under columns the height was whatever the column's width made it.
  // A masonry cell asks for the zoom's height at its own aspect, so the zoom is the
  // one divided by the other.
  const box = async (i: number) => (await tiles(page).nth(i).boundingBox())!;
  const { zoom, pad } = await tiles(page)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        zoom: parseFloat(style.flexBasis) / parseFloat(style.aspectRatio),
        pad: parseFloat(style.paddingTop),
      };
    });
  const first = await box(0);
  const second = await box(1);
  expect(second.y).toBeCloseTo(first.y, 0);
  // The zoom sizes the photograph; the cell is that plus the pad it stands the ring
  // off it by.
  expect(first.height - 2 * pad).toBeCloseTo(zoom, 0);
  expect(second.height).toBeCloseTo(first.height, 0);

  // A ring at the cell edge runs a pad outside the photograph, so its corner curves
  // a pad wider than the picture's - at one radius for both it read tighter than the
  // picture it was drawn around.
  const cell = await tiles(page).first().evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  const picture = await frames(tiles(page).first()).evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(cell).toBeCloseTo(picture + pad, 1);

  await setViewMode(page, 'Grid');
});

test('a list row draws its name and date over the frame, not under it', async ({ page }) => {
  await gotoLibrary(page, LAYOUT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  await setViewMode(page, 'List');

  // Regression: a row's foot is in the row's own grid rather than over the picture,
  // and in flow it painted *under* the hit overlay, which spans the whole row. Hit testing
  // follows paint order, so asking what is on top at the name says which one won -
  // with the foot's clicks handed back to the frame only for the length of the ask.
  const name = await tileName(tiles(page).first());
  const onTop = await gallery(page).getByText(name, { exact: true }).evaluate((el) => {
    const foot = el.parentElement!;
    const handedBack = foot.style.pointerEvents;
    foot.style.pointerEvents = 'auto';
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    foot.style.pointerEvents = handedBack;
    return top === el;
  });
  expect(onTop).toBe(true);

  await setViewMode(page, 'Grid');
});

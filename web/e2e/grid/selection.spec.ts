// Choosing photographs in the grid: what the frame, the tick box, a modified click
// and the keyboard each do, and when a click opens a photo instead (§18.3.1).
// Nothing here writes to the catalogue, so the tests are independent of one
// another.
import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { SELECT_PHOTOS_DIR, SELECT_PHOTO_NAMES } from '../fixture_library';
import {
  cursorTile,
  frames,
  gotoLibrary,
  openPhoto,
  picks,
  selectPhoto,
  selectedTiles,
  selectionBar,
  sidebarLibrary,
  ticked,
  tiles,
  useLibrary,
} from '../helpers';

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, SELECT_PHOTOS_DIR, { photos: SELECT_PHOTO_NAMES.length });
});

// The frame belongs to navigation, and the tick box is the way into a selection.
test('the tick box starts a selection and the frame then toggles', async ({ page }) => {
  await gotoLibrary(page, SELECT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(SELECT_PHOTO_NAMES.length);

  await expect(selectionBar(page)).toBeHidden();
  await selectPhoto(page, 0);
  await expect(selectedTiles(page)).toHaveCount(1);
  await expect(selectionBar(page)).toBeVisible();
  expect(page.url()).not.toContain(`${route(PathSegment.photos())}/`);

  // With something chosen the grid is picking rather than browsing, so a plain
  // click adds and removes instead of opening the photo.
  await frames(tiles(page).nth(1)).click();
  await expect(selectedTiles(page)).toHaveCount(2);
  await frames(tiles(page).nth(1)).click();
  await expect(selectedTiles(page)).toHaveCount(1);
  expect(page.url()).not.toContain(`${route(PathSegment.photos())}/`);

  // None of those drew the cursor: the ring says where the keyboard is, and one a
  // click left behind marks a photograph nobody is acting on. That the clicks
  // still *moved* it is the next test.
  await expect(cursorTile(page)).toHaveCount(0);

  // Dropping the selection takes the bar with it, and hands the frame back.
  await page.keyboard.press('Escape');
  await expect(selectedTiles(page)).toHaveCount(0);
  await expect(selectionBar(page)).toBeHidden();

  await openPhoto(page, 0);
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.photos())}/`));
});

// The file-manager gesture, kept: it reaches a selection without going for the box.
test('cmd-click builds a selection without opening anything', async ({ page }) => {
  await gotoLibrary(page, SELECT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(SELECT_PHOTO_NAMES.length);

  await frames(tiles(page).first()).click({ modifiers: ['ControlOrMeta'] });
  await expect(selectedTiles(page)).toHaveCount(1);
  expect(page.url()).not.toContain(`${route(PathSegment.photos())}/`);

  await frames(tiles(page).nth(1)).click({ modifiers: ['ControlOrMeta'] });
  await expect(selectedTiles(page)).toHaveCount(2);
  await frames(tiles(page).first()).click({ modifiers: ['ControlOrMeta'] });
  await expect(selectedTiles(page)).toHaveCount(1);
  await expect(picks(tiles(page).first())).not.toBeChecked();
  await expect(cursorTile(page)).toHaveCount(0);

  // The clicks moved the cursor even though they did not draw it, so the keyboard
  // carries on from where they left it: the last click was tile 0, so ArrowRight
  // is tile 1. A cursor the clicks had never touched would still be outside the
  // grid, and the same key would land on tile 0.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await expect(tiles(page).nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(tiles(page).first()).not.toHaveAttribute('aria-current', 'true');
});

test('the cursor moves without choosing anything, and Enter opens what it is on', async ({ page }) => {
  await gotoLibrary(page, SELECT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(SELECT_PHOTO_NAMES.length);

  // Focus on the sidebar link, as a reader who arrived by clicking it has it, until the
  // first arrow key hands it to the grid - without which Enter belongs to the link and
  // the cull's own "open" is dead.
  await sidebarLibrary(page, SELECT_PHOTOS_DIR).focus();
  await page.keyboard.press('ArrowRight');
  await expect(cursorTile(page)).toHaveCount(1);
  await expect(selectedTiles(page)).toHaveCount(0);
  await expect(selectionBar(page)).toBeHidden();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.photos())}/`));
});

// Building a set from the keyboard, which is the one key that selects.
test('Space toggles the photo under the cursor', async ({ page }) => {
  await gotoLibrary(page, SELECT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(SELECT_PHOTO_NAMES.length);

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(selectedTiles(page)).toHaveCount(1);
  // A chosen tile wears the selection's ring alone rather than stacking the two.
  await expect(cursorTile(page)).toHaveCount(0);

  await page.keyboard.press('Space');
  await expect(selectedTiles(page)).toHaveCount(0);
  // And the cursor is drawn again underneath it, since the keyboard is still
  // where the reader is.
  await expect(cursorTile(page)).toHaveCount(1);
});

// Picking a burst out of a shoot is a range, not forty clicks.
test('shift-click extends the selection from the anchor', async ({ page }) => {
  await gotoLibrary(page, SELECT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(SELECT_PHOTO_NAMES.length);

  const last = SELECT_PHOTO_NAMES.length - 1;
  // Which tiles are ringed, not how many: four frames, so a span from one end to
  // the other and a click on each end are two different answers.
  const chosen = (): Promise<boolean[]> => ticked(tiles(page), SELECT_PHOTO_NAMES.length);

  // The cursor answers for the anchor when nothing has been toggled: arrow to a
  // photo, shift-click another, get everything between them.
  await page.keyboard.press('ArrowRight');
  await expect(tiles(page).first()).toHaveAttribute('aria-current', 'true');
  await frames(tiles(page).nth(2)).click({ modifiers: ['Shift'] });
  await expect(selectedTiles(page)).toHaveCount(3);
  expect(await chosen()).toEqual([true, true, true, false]);

  // And it does not open the photo on the way.
  expect(page.url()).not.toContain(`${route(PathSegment.photos())}/`);

  // Anchored on the last tile alone, so a range that reaches back to the second
  // is the only way the middle can come back: the anchor is where the range
  // starts from, not what happens to be selected.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await selectPhoto(page, last);
  await expect(selectedTiles(page)).toHaveCount(1);
  await frames(tiles(page).nth(1)).click({ modifiers: ['Shift'] });
  expect(await chosen()).toEqual([false, true, true, true]);

  // Unpicking one photo turns the gesture around, which is how a few frames come
  // out of a long run: the anchor carries the verb of the pick that set it, so a
  // span drawn back from an unpicked photo unpicks the stretch rather than
  // putting it back in.
  await selectPhoto(page, last);
  await frames(tiles(page).nth(2)).click({ modifiers: ['Shift'] });
  expect(await chosen()).toEqual([false, true, false, false]);

  // The tick box is the same gesture: it carries the modifier through to the same
  // span rather than only ever picking the one photo under it.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await selectPhoto(page, 0);
  await picks(page).nth(2).click({ modifiers: ['Shift'] });
  expect(await chosen()).toEqual([true, true, true, false]);
});

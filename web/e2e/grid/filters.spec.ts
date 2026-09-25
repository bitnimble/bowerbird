// Narrowing the grid: the verdict presets, and the panel behind them holding the
// set they are named points in, the filename search and the range of days.
import { expect, test, type Page } from '@playwright/test';
import { FILTER_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import { cursorTile, gallery, gotoLibrary, sidebarSection, tiles, useLibrary } from '../helpers';

// Every filter but the five presets lives behind one button, so a test that asks
// about one opens it first.
const openFilters = (page: Page): Promise<void> => page.getByRole('button', { name: /^Filters/ }).click();
const filterPanel = (page: Page) => page.getByRole('textbox', { name: 'Find by filename' });
const bodyList = (page: Page) => page.getByRole('dialog', { name: 'Camera body' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, FILTER_PHOTOS_DIR);

  // A filter is a question about verdicts, so one photograph has to carry one.
  // What these controls do from the grid is `grid/triage.spec.ts`; here they are
  // how the fixture gets its picked, rated frame.
  const page = await browser.newPage();
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  await page.keyboard.press('ArrowRight');
  await expect(cursorTile(page)).toHaveCount(1);
  await page.keyboard.press('4');
  await page.keyboard.press('c');
  await expect(tiles(page).first().getByRole('button', { name: 'Clear Pick', pressed: true })).toBeVisible();
  await page.close();
});

test('the Picks filter narrows to what was picked', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await page.getByRole('button', { name: 'Picks', exact: true }).click();
  await expect(tiles(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
});

test('filename search finds a single frame', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await openFilters(page);
  await page.getByLabel('Find by filename').fill('alpha');
  await expect(tiles(page)).toHaveCount(1);
  await expect(gallery(page).getByText('alpha.arw', { exact: true })).toBeVisible();

  // One question of the collection, so one on the badge - the search is a narrowing
  // and the preset it was asked alongside is where the reader started.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
});

test('a search cleared from outside the box stays cleared', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await openFilters(page);
  const box = page.getByLabel('Find by filename');

  await box.fill('alpha');
  await expect(tiles(page)).toHaveCount(1);

  // Regression: the box kept its own copy of the text and its debounce compared
  // that stale copy against the freshly emptied store, writing the old search
  // back 250ms later. Opening another collection resets the filters, which is
  // exactly that external clear. Waiting past the debounce is the point.
  await sidebarSection(page, FILTER_PHOTOS_DIR, 'Bin').click();
  await page.waitForTimeout(600);
  await openFilters(page);
  await expect(box).toHaveValue('');
  await expect(tiles(page)).toHaveCount(0);
});

test('the filter set unions its options instead of intersecting them', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  // A preset is a named point in the same space as the set behind it, so it arrives
  // with its own options already ticked. Start from All, which ticks nothing, or the
  // clicks below would be toggling the Active preset's boxes off.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await openFilters(page);
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0);

  // One photo of this library is picked and rated; the rest are neither. As an
  // intersection "picks AND unrated" is empty, so a union is the only reading
  // that returns the whole set.
  await page.getByRole('checkbox', { name: 'Picks' }).check();
  await page.getByRole('checkbox', { name: 'Unrated' }).check();
  await page.keyboard.press('Escape');

  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  // The verdict set and the rating are one narrowing each, however many boxes say so.
  await expect(page.getByRole('button', { name: 'Filters (2)' })).toBeVisible();
});

test('the bodies a collection was shot on open beside the panel rather than in it', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  await openFilters(page);

  // Hovering is what opens it, as a submenu does. Every frame of this fixture is the
  // same file, so the list is the one body they were all shot on.
  await page.getByRole('button', { name: 'Camera body' }).hover();
  const bodies = bodyList(page).getByRole('checkbox');
  await expect(bodies).toHaveCount(1);
  await bodies.first().check();

  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  // What is ticked out of sight: on the row while the list is open, and on the button
  // that opens the panel either way.
  await expect(page.getByRole('button', { name: 'Camera body' })).toContainText('1');
  await expect(page.getByRole('button', { name: 'Filters (1)' })).toBeVisible();
});

test('a list left open does not open itself the next time the panel is', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  // Shut from outside while a list is open, which is what a portal takes away rather
  // than closes: the list is never told, so its row has to be.
  await openFilters(page);
  await page.getByRole('button', { name: 'Camera body' }).hover();
  await expect(bodyList(page)).toBeVisible();
  await page.getByText(/^[\d,]+ photos?$/).click();
  await expect(filterPanel(page)).toHaveCount(0);

  await openFilters(page);
  await expect(bodyList(page)).toHaveCount(0);

  // And the same by key, which dismisses the list and the panel one after the other.
  await page.getByRole('button', { name: 'Camera body' }).hover();
  await expect(bodyList(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(filterPanel(page)).toHaveCount(0);

  await openFilters(page);
  await expect(bodyList(page)).toHaveCount(0);
});

test('a preset filter arrives with its options already ticked, and wears no badge', async ({ page }) => {
  await gotoLibrary(page, FILTER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  // Active is untriaged + picked, so the set must show exactly those two ticked
  // rather than looking as though no filter were applied.
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await openFilters(page);
  await expect(page.getByRole('checkbox', { name: 'Untriaged', checked: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Picks', checked: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Rejects', checked: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // And no count on the button: the working set is where the reader starts rather
  // than something they asked for, so a badge on it would never come off.
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
});

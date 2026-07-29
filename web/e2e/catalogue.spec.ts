import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, syncLibrary } from './helpers';

// One ordered journey: each step depends on the catalogue state the previous one
// produced, which is also how the bugs below were originally found.
test.describe.configure({ mode: 'serial' });

test('indexes a library and shows a thumbnail for every RAW file', async ({ page }) => {
  await addLibrary(page, PHOTOS_DIR);
  await syncLibrary(page, PHOTOS_DIR);
  await openLibrary(page, PHOTOS_DIR);

  // Longer than the configured 15s default: unlike the other assertions, this one
  // waits on a real scan (LibRaw opens every new file), so it scales with the
  // fixture and the machine rather than with the UI.
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });

  // Regression: thumbnails are requested before processing has written them, so
  // the first request 404s, and the tile has nothing to do but wait for the
  // server to say its photo is built. Every tile must end up showing decoded
  // pixels, and none may be left on the placeholder.
  await expect
    .poll(
      async () =>
        page.locator('.tile img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length),
      { timeout: 45_000 },
    )
    .toBe(PHOTO_NAMES.length);
  await expect(page.locator('.tile__pending')).toHaveCount(0);
});

test('the sort follows the collection rather than the browser it was set in', async ({ page }) => {
  // The point of storing it on the collection: clearing this browser's state is
  // what a second device looks like, and the sort has to survive it. Held in
  // localStorage, as it was, the reload below came back sorted by the default.
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  const sort = page.getByRole('combobox', { name: 'Sort photos' });
  await expect(sort).toHaveText('Oldest first');

  await sort.click();
  await page.getByRole('option', { name: 'Recently added' }).click();
  await expect(sort).toHaveText('Recently added');

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openLibrary(page, PHOTOS_DIR);
  await expect(sort).toHaveText('Recently added');

  // Put it back, so the ordered journey the rest of this file depends on carries
  // on in the order it expects.
  await sort.click();
  await page.getByRole('option', { name: 'Oldest first' }).click();
  await expect(sort).toHaveText('Oldest first');
});

test('keeps the library in the shell when a shoot is opened by deep link', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();

  await page.getByLabel('Shoot name').fill('Reef');
  await page.getByRole('button', { name: 'Create shoot' }).click();
  await expect(page.locator('.list__name', { hasText: 'Reef' })).toBeVisible();

  const shootHref = await page.getByRole('link', { name: 'View photos' }).first().getAttribute('href');
  expect(shootHref).not.toBeNull();

  // Regression: /shoots/:id carries no library id, so the rail used to blank out
  // and the user lost every way back into the library.
  await page.goto(shootHref!);
  await expect(page.locator('.rail__link', { hasText: 'Bin' })).toBeVisible();
  await expect(page.locator('.rail__link', { hasText: 'Shoots' })).toBeVisible();
  await expect(page.locator(`.rail__link[title="${PHOTOS_DIR}"]`)).toBeVisible();
});

test('adding a photo to a shoot moves the file out of the library root on disk', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await expect(page.locator('.bulkbar__count')).toHaveText('1 selected');
  await page.getByRole('button', { name: 'Add to shoot' }).click();
  await page.getByRole('menuitemcheckbox', { name: /Reef/ }).click();

  await page.getByRole('link', { name: 'Shoots', exact: true }).click();
  await page.getByRole('link', { name: 'View photos' }).first().click();
  await expect(page.locator('.tile')).toHaveCount(1);

  // A shoot is a real folder, so the add is a file move, not just a DB flag.
  const inShoot = readdirSync(`${PHOTOS_DIR}/Reef`).filter((f) => f.endsWith('.arw'));
  expect(inShoot).toHaveLength(1);
  const atRoot = readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.arw'));
  expect(atRoot).toHaveLength(PHOTO_NAMES.length - 1);
  expect(atRoot).not.toContain(inShoot[0]);
});

test('a photo can be taken back out of a shoot', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();
  await page.getByRole('link', { name: 'View photos' }).first().click();
  await expect(page.locator('.tile')).toHaveCount(1);

  // Removal goes over DELETE with a JSON body (§13.3). Hono/Bun do parse that,
  // but nothing exercised it until the remove button existed, so pin it here:
  // a dropped body would silently no-op and leave the photo in the shoot.
  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: /^Remove from / }).click();

  await expect(page.locator('.tile')).toHaveCount(0);
  const atRoot = readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.arw'));
  expect(atRoot).toHaveLength(PHOTO_NAMES.length);
});

test('masonry lays photos out across a row, not down a column', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  await page.getByRole('button', { name: 'Masonry' }).click();

  // Regression: laid out with CSS columns, the tiles ran down the first column
  // before starting the second, which a paged or infinite list cannot do - it
  // has no bottom to fill to. They now sit on a row of one height, which is the
  // zoom size: under columns the height was whatever the column's width made it.
  const box = async (i: number) => (await page.locator('.tile').nth(i).boundingBox())!;
  const zoom = await page.locator('.grid').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--tile')));
  const first = await box(0);
  const second = await box(1);
  expect(second.y).toBeCloseTo(first.y, 0);
  expect(first.height).toBeCloseTo(zoom, 0);
  expect(second.height).toBeCloseTo(first.height, 0);

  await page.getByRole('button', { name: 'Grid' }).click();
});

test('the bin shows only soft-deleted photos, and the library hides them', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Move to Bin' }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  // Regression: include_deleted alone returns live + deleted, so the Bin showed
  // the whole library. It needs the is_deleted filter to mean "only the Bin".
  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.badge--deleted')).toHaveCount(1);
});

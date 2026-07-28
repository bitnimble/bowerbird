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

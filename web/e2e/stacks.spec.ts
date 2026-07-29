import { expect, test } from '@playwright/test';
import { PHOTO_NAMES, STACK_PHOTOS_DIR } from './fixture_library';
import { addLibrary, openLibrary, syncLibrary, waitForSyncSettled } from './helpers';

// Stacks, driven through the real grid (DESIGN §19).
//
// The fixture is one ARW copied under two names, so the frames are identical and
// detection groups them - which is the right answer for a library of duplicates,
// and what lets this spec exercise the real detection path without shipping a
// second RAW. The other specs switch stacking off for exactly the same reason.
//
// Serial because each test leaves the library in the state the next one starts
// from, and they share one catalogue.
test.describe.configure({ mode: 'serial' });

test('identical frames collapse into one tile that says how many it stands for', async ({ page }) => {
  // The one library that keeps stacking on: its frames are the ones meant to be
  // found alike.
  await addLibrary(page, STACK_PHOTOS_DIR, { autoStack: true });
  await syncLibrary(page, STACK_PHOTOS_DIR);
  // Detection runs as part of settling, so the grid has to be opened after it
  // rather than during the import.
  await waitForSyncSettled(page, STACK_PHOTOS_DIR, PHOTO_NAMES.length);
  await openLibrary(page, STACK_PHOTOS_DIR);

  await expect(page.locator('.tile')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('.tile__stack-count')).toHaveText(String(PHOTO_NAMES.length));
});

test('the badge opens a band of members below the row, and closes it again', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  const badge = page.locator('.tile__stack');
  await expect(badge).toBeVisible({ timeout: 45_000 });

  await badge.click();
  await expect(page.locator('.grid__band')).toHaveCount(1);
  await expect(page.locator('.grid__band .tile')).toHaveCount(PHOTO_NAMES.length);
  // The stack's own tile stays where it is, now marked as what closes the band.
  await expect(page.locator('.tile__stack--open')).toHaveCount(1);

  await page.locator('.tile__stack--open').click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

test('a member picked out of the band can be removed from the stack', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await page.locator('.tile__stack').click();
  await expect(page.locator('.grid__band .tile')).toHaveCount(PHOTO_NAMES.length);

  // Members select by id and get their own bulk bar: a selection inside a stack
  // and a selection of the collection are different intentions (§19.6.1).
  await page.locator('.grid__band .tile__check').first().click();
  const remove = page.getByRole('button', { name: 'Remove from stack' });
  await expect(remove).toBeVisible();
  await remove.click();

  // One member left is a photograph rather than a stack, so the badge goes and
  // the collection is two ordinary tiles again.
  await expect(page.locator('.tile__stack')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('a stack made by hand can be unstacked again', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });

  for (const check of await page.locator('.tile__check').all()) await check.click();
  await page.getByRole('button', { name: 'Stack', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);

  await page.locator('.tile__check').click();
  await page.getByRole('button', { name: 'Unstack' }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

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

test('the tile opens a band of members below the row, and closes it again', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  const tile = page.locator('.tile:not(.tile--member) .tile__hit');

  await tile.click();
  await expect(page.locator('.grid__band')).toHaveCount(1);
  await expect(page.locator('.grid__band .tile')).toHaveCount(PHOTO_NAMES.length);
  // The stack's own tile stays where it is, now marked as what closes the band.
  await expect(page.locator('.tile__stack--open')).toHaveCount(1);

  await tile.click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

test('every view opens the band, and none of them draws it over the grid', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  const tile = page.locator('.tile:not(.tile--member) .tile__hit');
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });

  for (const view of ['Masonry', 'List', 'Grid']) {
    await page.getByRole('button', { name: view }).click();
    // Masonry packs from each photo's shape rather than on a row model, and used
    // to offer no way into a stack at all.
    await expect(page.locator('.tile__stack')).toBeVisible();

    await tile.click();
    const band = page.locator('.grid__band');
    await expect(band).toHaveCount(1);
    await expect(page.locator('.grid__band .tile')).toHaveCount(PHOTO_NAMES.length);

    // The members sit inside the outline rather than on it: the band pays for
    // that padding out of its own cells, so its last row cannot hang through the
    // bottom of it.
    const box = (await band.boundingBox())!;
    const last = (await page.locator('.grid__band .tile').last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height);
    expect(last.y).toBeGreaterThanOrEqual(box.y);

    await tile.click();
    await expect(page.locator('.grid__band')).toHaveCount(0);
  }
});

test('a masonry band leaves the line it broke at the size it was', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Masonry' }).click();

  const tile = page.locator('.tile:not(.tile--member)');
  const before = (await tile.boundingBox())!;
  await tile.locator('.tile__hit').click();
  await expect(page.locator('.grid__band')).toHaveCount(1);

  // The band is a full-width item and goes after the line its tile sits on, so
  // nothing on that line changes size: a band that broke the line where the tile
  // was handed it the width the band took, stretching the stack across the grid.
  expect((await tile.boundingBox())!.width).toBeCloseTo(before.width, 0);

  await tile.locator('.tile__hit').click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

test('a list row opens its stack from anywhere along it, not just the thumbnail', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'List' }).click();

  // Clicked where the filename is, which is most of a list row and used to be
  // dead space: through the mouse rather than the locator, because the point of
  // this is which element the click lands on and Playwright would refuse to
  // click one that hands its clicks to the row.
  const name = (await page.locator('.tile:not(.tile--member) .tile__name').boundingBox())!;
  await page.mouse.click(name.x + name.width / 2, name.y + name.height / 2);
  await expect(page.locator('.grid__band')).toHaveCount(1);
  // A member row says as much about itself as any other row does.
  await expect(page.locator('.grid__band .tile').first().getByText(/\d{4}/)).toBeVisible();

  await page.getByRole('button', { name: 'Grid' }).click();
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

test('a member picked out of the band can be removed from the stack', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
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

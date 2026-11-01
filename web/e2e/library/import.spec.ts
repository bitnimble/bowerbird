import { expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { PathSegment, route } from '../../../src/schemas/route';
import { test } from '../fixtures';
import { IMPORT_CARD_DIR, IMPORT_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import { gotoLibrary, tiles, useLibrary } from '../helpers';

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, IMPORT_PHOTOS_DIR);
});

test('a card scanned and added lands in the library, leaving what it already held', async ({
  page,
}) => {
  await page.goto(route(PathSegment.imports()));
  await page.getByRole('combobox', { name: 'Library' }).click();
  await page.getByRole('option', { name: path.basename(IMPORT_PHOTOS_DIR) }).click();
  await page.getByRole('button', { name: 'Choose folder' }).click();
  await page.getByRole('textbox', { name: 'Source' }).fill(`${IMPORT_CARD_DIR}/`);
  await page.getByRole('dialog').getByRole('button', { name: 'Choose folder' }).click();
  await page.getByRole('button', { name: 'Scan', exact: true }).click();

  const held = page.getByRole('checkbox', { name: 'alpha.arw' });
  const fresh = page.getByRole('checkbox', { name: 'card_one.arw' });
  await expect(fresh).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'card_two.arw' })).toBeChecked();
  await expect(page.getByText('Already in library')).toHaveCount(1);
  await expect(held).not.toBeChecked();

  // The embedded JPEG of a real RAW, drawn by the browser.
  const picture = page.locator('label', { has: fresh }).locator('img');
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Add to library' }).click();
  await expect(page.getByText('Added 2 files to the library.')).toBeVisible();
  // Copied, not moved, and marked the same way what was already there is.
  await expect(page.getByText('Already in library')).toHaveCount(3);

  expect(existsSync(path.join(IMPORT_PHOTOS_DIR, 'card_one.arw'))).toBe(true);
  expect(existsSync(path.join(IMPORT_PHOTOS_DIR, 'alpha_1.arw'))).toBe(false);
  expect(statSync(path.join(IMPORT_CARD_DIR, 'DCIM/100MSDCF/card_one.arw')).isFile()).toBe(true);

  await gotoLibrary(page, IMPORT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length + 2);
});

import { expect, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { PathSegment, route } from '../../../src/schemas/route';
import { test } from '../fixtures';
import {
  E2E_ROOT,
  IMPORT_CARD_DIR,
  IMPORT_CARD_FOLDER,
  IMPORT_PHOTOS_DIR,
  PHOTO_NAMES,
} from '../fixture_library';
import { gotoLibrary, tiles, useLibrary } from '../helpers';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, IMPORT_PHOTOS_DIR);
});

async function scanForImport(page: Page, source: string): Promise<void> {
  await page.goto(route(PathSegment.imports()));
  await page.getByRole('combobox', { name: 'Library' }).click();
  await page.getByRole('option', { name: path.basename(IMPORT_PHOTOS_DIR) }).click();
  await page.getByRole('button', { name: 'Choose folder' }).click();
  await page.getByRole('textbox', { name: 'Source' }).fill(`${source}/`);
  await page.getByRole('dialog').getByRole('button', { name: 'Choose folder' }).click();
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
}

test('a card scanned and added lands in the library, leaving what it already held', async ({
  page,
}) => {
  await scanForImport(page, IMPORT_CARD_DIR);

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
  expect(statSync(path.join(IMPORT_CARD_FOLDER, 'card_one.arw')).isFile()).toBe(true);

  await gotoLibrary(page, IMPORT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length + 2);
});

test('deleting after copying takes the card file once its copy is in the library', async ({
  page,
}) => {
  const card = path.join(E2E_ROOT, 'import-delete-card');
  const onCard = path.join(card, 'card_three.arw');
  rmSync(card, { recursive: true, force: true });
  mkdirSync(card, { recursive: true });
  copyFileSync(path.join(IMPORT_PHOTOS_DIR, 'card_one.arw'), onCard);

  await scanForImport(page, card);
  await expect(page.getByRole('checkbox', { name: 'card_three.arw' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Delete after copying' }).check();
  await page.getByRole('button', { name: 'Add to library' }).click();
  await page.getByRole('button', { name: 'Copy and delete' }).click();

  await expect(page.getByText('Added 1 file to the library and deleted 1 original.')).toBeVisible();
  await expect(page.getByText('No photos found')).toBeVisible();
  expect(existsSync(onCard)).toBe(false);
  expect(existsSync(path.join(IMPORT_PHOTOS_DIR, 'card_three.arw'))).toBe(true);

  await gotoLibrary(page, IMPORT_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length + 3);
});

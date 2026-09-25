import { expect, test } from '@playwright/test';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ARCHIVE_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import {
  addLibrary,
  bulkAction,
  openLibrary,
  sidebarSection,
  selectPhoto,
  tiles,
} from '../helpers';

// A read-only library, through the app the way a photographer reaches it: added
// with the box ticked, binned from the grid, checked in the Bin, restored. The
// assertion the rest of the suite cannot make is the last one - that the folder
// on disk is exactly what it was before any of that happened.
function tree(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, tree(path.join(dir, entry.name), rel));
    else {
      const stats = statSync(path.join(dir, entry.name));
      out[rel] = `${stats.size}@${stats.mtimeMs}`;
    }
  }
  return out;
}

test('a read-only library bins and restores without touching the folder', async ({ page }) => {
  await addLibrary(page, ARCHIVE_PHOTOS_DIR, { readOnly: true });

  // Recorded after the import, which is the last thing allowed to have written
  // anything - and it wrote nothing under the root either.
  const before = tree(ARCHIVE_PHOTOS_DIR);
  expect(Object.keys(before).sort()).toEqual([...PHOTO_NAMES].sort());

  await openLibrary(page, ARCHIVE_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  await selectPhoto(page);
  await bulkAction(page, 'Move to Bin');
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length - 1);

  await sidebarSection(page, ARCHIVE_PHOTOS_DIR, 'Bin').click();
  await expect(page.getByRole('heading', { name: 'Bin' })).toBeVisible();
  await expect(tiles(page)).toHaveCount(1);

  await selectPhoto(page);
  await page.getByRole('button', { name: 'Restore to original location' }).click();
  await expect(tiles(page)).toHaveCount(0);

  await openLibrary(page, ARCHIVE_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  // No bin folder, no suffixed `alpha_1.arw` from a restore that claimed the name
  // its own file already held, and not one mtime moved.
  expect(tree(ARCHIVE_PHOTOS_DIR)).toEqual(before);
});

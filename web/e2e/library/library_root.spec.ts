import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { existsSync, renameSync } from 'node:fs';
import type { Library } from '../../../src/schemas/libraries';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHOTO_NAMES, RELOCATE_PHOTOS_DIR } from '../fixture_library';
import { addLibrary, forgetLibrary, libraryOf, libraryPhotos } from '../helpers';

const MOVED = `${RELOCATE_PHOTOS_DIR}-moved`;

// Missing with no copy on another device counts as unavailable instead.
function absent(library: Library): number {
  return library.missing_photo_count + library.unavailable_photo_count;
}

test.describe.configure({ mode: 'serial' });

test('a library pointed at the folder it was moved to keeps its photos', async ({ page }) => {
  if (existsSync(MOVED)) renameSync(MOVED, RELOCATE_PHOTOS_DIR);
  await forgetLibrary(page, MOVED);
  await addLibrary(page, RELOCATE_PHOTOS_DIR);
  const before = (await libraryPhotos(page, RELOCATE_PHOTOS_DIR)).map((photo) => photo.id).sort();
  expect(before).toHaveLength(PHOTO_NAMES.length);
  const { id } = await libraryOf(page, RELOCATE_PHOTOS_DIR);
  renameSync(RELOCATE_PHOTOS_DIR, MOVED);
  // Missing first, so finding them again is the re-point's doing.
  await expect
    .poll(
      async () => {
        await page.request.post(
          route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.sync()),
          { timeout: 60_000 },
        );
        return absent(await libraryOf(page, RELOCATE_PHOTOS_DIR));
      },
      { timeout: 60_000 },
    )
    .toBe(PHOTO_NAMES.length);

  await page.goto(route(PathSegment.settings(), PathSegment.libraries(), id));
  const settings = page.getByRole('dialog', { name: /^Settings for / });
  const picker = settings.getByRole('group', { name: 'Library folder' });
  await picker.getByRole('button', { name: 'Choose folder' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose folder' });
  const folder = chooser.getByLabel('Library folder');
  await expect(folder).not.toHaveValue('');
  await folder.fill(MOVED);
  await folder.press('Enter');
  await expect(folder).toHaveValue(MOVED);
  await chooser.getByRole('button', { name: 'Choose folder' }).click();

  await expect(settings).toContainText(MOVED);
  await expect
    .poll(async () => {
      const library = await libraryOf(page, MOVED);
      return `${library.photo_count} photos, ${absent(library)} absent`;
    })
    .toBe(`${PHOTO_NAMES.length} photos, 0 absent`);
  expect((await libraryPhotos(page, MOVED)).map((photo) => photo.id).sort()).toEqual(before);
});

// A tile's right-click menu, and copying one photo's edits onto another through it.
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { EditStateSchema } from '../../../src/schemas/photo_edits';
import { PathSegment, route } from '../../../src/schemas/route';
import { TILE_MENU_PHOTOS_DIR } from '../fixture_library';
import { gotoLibrary, gotoPhoto, libraryPhotos, selectPhoto, tiles, useLibrary } from '../helpers';

// Every test writes the same two photographs' edits.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, TILE_MENU_PHOTOS_DIR);
});

const editsOf = (photoId: string): string =>
  route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits());

async function bothPhotos(page: Page): Promise<[string, string]> {
  const [first, second] = await libraryPhotos(page, TILE_MENU_PHOTOS_DIR);
  if (first == null || second == null) throw new Error('the library needs 2 photos');
  return [first.id, second.id];
}

async function exposureOf(page: Page, photoId: string): Promise<number> {
  return EditStateSchema.parse(await (await page.request.get(editsOf(photoId))).json()).doc
    .exposure;
}

async function develop(page: Page, photoId: string, exposure: number): Promise<void> {
  const { doc, rev } = EditStateSchema.parse(
    await (await page.request.get(editsOf(photoId))).json(),
  );
  const saved = await page.request.put(editsOf(photoId), {
    data: { doc: { ...doc, exposure, cropLeft: 0.2 }, rev, session: `e2e${rev}` },
  });
  expect(saved.ok()).toBe(true);
}

const menuOf = (page: Page) => page.getByRole('menu', { name: 'Photo actions' });

test('copies the edits of one photo and pastes them onto another', async ({ page }) => {
  const [first, second] = await bothPhotos(page);
  await develop(page, first, 1.25);

  await gotoLibrary(page, TILE_MENU_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(2);

  await tiles(page).nth(0).click({ button: 'right' });
  await expect(menuOf(page)).toBeVisible();
  await menuOf(page).getByRole('menuitem', { name: 'Copy edits' }).click();
  await expect(page.getByText('Edits copied.')).toBeVisible();

  await tiles(page).nth(1).click({ button: 'right' });
  await menuOf(page).getByRole('menuitem', { name: 'Paste edits' }).click();
  await expect(page.getByText('Edits pasted.')).toBeVisible();

  const pasted = EditStateSchema.parse(await (await page.request.get(editsOf(second))).json());
  expect(pasted.doc.exposure).toBe(1.25);
  // The framing is the photo's own.
  expect(pasted.doc.cropLeft).toBe(0);
});

test('stays open while the pointer crosses the grid', async ({ page }) => {
  await gotoLibrary(page, TILE_MENU_PHOTOS_DIR);
  await tiles(page).nth(0).click({ button: 'right' });
  await expect(menuOf(page)).toBeVisible();

  await menuOf(page).getByRole('menuitem', { name: 'Copy edits' }).hover();
  // The menu's backdrop covers the grid, which `hover()` would wait out.
  const box = await tiles(page).nth(1).boundingBox();
  if (box == null) throw new Error('the second tile is not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(menuOf(page)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('acts on the whole selection from a selected tile', async ({ page }) => {
  await gotoLibrary(page, TILE_MENU_PHOTOS_DIR);
  await tiles(page).nth(0).click({ button: 'right' });
  await menuOf(page).getByRole('menuitem', { name: 'Copy edits' }).click();

  await selectPhoto(page, 0);
  await selectPhoto(page, 1);
  await tiles(page).nth(1).click({ button: 'right' });

  await expect(
    menuOf(page).getByRole('menuitem', { name: 'Paste edits to 2 photos' }),
  ).toBeVisible();
  await expect(menuOf(page).getByRole('menuitem', { name: 'Copy edits' })).toHaveCount(0);
  await expect(menuOf(page).getByRole('menuitem', { name: 'Move 2 to Bin' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuOf(page)).toBeHidden();
});

test('pastes from the filmstrip under the photo viewer', async ({ page }) => {
  const [first, second] = await bothPhotos(page);
  await develop(page, first, 0.5);

  await gotoPhoto(page, TILE_MENU_PHOTOS_DIR);
  await page.getByRole('button', { name: 'Show filmstrip' }).click();
  await tiles(page).nth(1).click({ button: 'right' });
  // Nothing copied in this page yet.
  await expect(menuOf(page).getByRole('menuitem', { name: 'Paste edits' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await tiles(page).nth(0).click({ button: 'right' });
  await menuOf(page).getByRole('menuitem', { name: 'Copy edits' }).click();
  await tiles(page).nth(1).click({ button: 'right' });
  await menuOf(page).getByRole('menuitem', { name: 'Paste edits' }).click();
  await expect(page.getByText('Edits pasted.')).toBeVisible();

  expect(await exposureOf(page, second)).toBe(0.5);
});

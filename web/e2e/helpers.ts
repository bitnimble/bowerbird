import { expect, type Page } from '@playwright/test';

// Navigation the specs share. Libraries are added in Settings and then live
// permanently in the rail, so there is no "pick a library" screen to go through.
export function libraryRow(page: Page, rootPath: string) {
  return page.locator('.list__row', { hasText: rootPath });
}

export async function addLibrary(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add library' }).click();
  // The picker writes the folder it opened at into this box, so a path typed
  // before that lands would be overwritten by it.
  const path = page.getByLabel('Library root path');
  await expect(path).not.toHaveValue('');
  await path.fill(rootPath);
  // The dialog's own button carries the same name as the one that opened it, so
  // the confirm has to be scoped to the dialog.
  await page.locator('.ui-modal').getByRole('button', { name: 'Add library' }).click();
  await expect(libraryRow(page, rootPath)).toBeVisible();
}

// Points a library at the pixels its renditions are built from. The control is a
// Select, whose trigger is a combobox named after the setting rather than a
// button named after the value, so the value is picked from the menu it opens.
export async function setRenditionSource(page: Page, rootPath: string, source: string): Promise<void> {
  await libraryRow(page, rootPath).getByLabel('Build renditions from').click();
  await page.getByRole('option', { name: source }).click();
}

// Which rendition the photo viewer opens at, an app-wide setting rather than a
// per-library one. Same shape of control as above, and named for the question it
// answers rather than for the answer currently showing.
export async function setViewerRendition(page: Page, rendition: string): Promise<void> {
  await page.getByLabel('Default rendition in photo viewer').click();
  await page.getByRole('option', { name: rendition, exact: true }).click();
}

export async function syncLibrary(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await libraryRow(page, rootPath).getByRole('button', { name: /Sync/ }).click();
}

// From the library's Shoots page. Where the shoot goes is the row its + menu was
// opened from, so a root-level one comes from the library root's own menu.
export async function addShoot(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add to the library root' }).click();
  await page.getByRole('menuitem', { name: 'Create shoot in subfolder' }).click();
  await page.getByLabel('Shoot name').fill(name);
  await page.locator('.ui-modal').getByRole('button', { name: 'Create shoot' }).click();
}

// The rail lists every library by its folder name, with the full path as the
// title, which is the only unambiguous handle when two share a basename.
export async function openLibrary(page: Page, rootPath: string): Promise<void> {
  await page.locator(`.rail__link[title="${rootPath}"]`).click();
}

// Opens the first photo and swaps the rendition for the full-resolution render,
// which the server builds on first request.
export async function viewMaxQuality(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await openLibrary(page, rootPath);
  await page.locator('.tile__hit').first().click();
  // The full-size rendition is built by the background queue after a sync, so a
  // freshly synced library can wait on a real decode here.
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Rendition' }).click();
  await page.getByRole('menuitem', { name: 'Rendered RAW (max quality)' }).click();
  await expect(page.locator('.panel', { hasText: 'RENDITION DETAILS' }).getByText('Rendered RAW (max quality)')).toBeVisible({
    timeout: 180_000,
  });
  // The stage holds the previous frame until the new one has decoded, so the
  // panel naming the rendition is not yet the image carrying it.
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveAttribute('src', /\/renditions\/max/, { timeout: 60_000 });
}

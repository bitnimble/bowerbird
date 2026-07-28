import { expect, type Page } from '@playwright/test';

// Navigation the specs share. Libraries are added in Settings and then live
// permanently in the rail, so there is no "pick a library" screen to go through.
export function libraryRow(page: Page, rootPath: string) {
  return page.locator('.list__row', { hasText: rootPath });
}

export async function addLibrary(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await page.getByLabel('Library root path').fill(rootPath);
  await page.getByRole('button', { name: 'Add library' }).click();
  await expect(libraryRow(page, rootPath)).toBeVisible();
}

export async function syncLibrary(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await libraryRow(page, rootPath).getByRole('button', { name: /Sync/ }).click();
}

// The rail lists every library by its folder name, with the full path as the
// title, which is the only unambiguous handle when two share a basename.
export async function openLibrary(page: Page, rootPath: string): Promise<void> {
  await page.locator(`.rail__link[title="${rootPath}"]`).click();
}

// Opens the first photo and swaps the preview for the full-resolution render,
// which the server builds on first request.
export async function viewMaxQuality(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await openLibrary(page, rootPath);
  await page.locator('.tile__hit').first().click();
  // The full-size preview is built by the background queue after a sync, so a
  // freshly synced library can wait on a real decode here.
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Image source' }).click();
  await page.getByRole('menuitem', { name: 'From RAW (max quality)' }).click();
  await expect(page.locator('.panel', { hasText: 'IMAGE PREVIEW DETAILS' }).getByText('RAW render (max quality)')).toBeVisible({
    timeout: 180_000,
  });
  // The stage holds the previous frame until the new one has decoded, so the
  // panel naming the rendition is not yet the image carrying it.
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveAttribute('src', /\/renditions\/max/, { timeout: 60_000 });
}

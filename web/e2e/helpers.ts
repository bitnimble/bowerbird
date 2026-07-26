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

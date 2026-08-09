import { expect, type Page } from '@playwright/test';

// Navigation the specs share. Libraries are added in Settings and then live
// permanently in the rail, so there is no "pick a library" screen to go through.
export function libraryRow(page: Page, rootPath: string) {
  return page.locator('.list__row', { hasText: rootPath });
}

export async function addLibrary(
  page: Page,
  rootPath: string,
  options: { autoStack?: boolean; readOnly?: boolean } = {},
): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add library' }).click();
  // The picker writes the folder it opened at into this box, so a path typed
  // before that lands would be overwritten by it.
  const path = page.getByLabel('Library root path');
  await expect(path).not.toHaveValue('');
  await path.fill(rootPath);
  if (options.readOnly === true) {
    await page.locator('.ui-modal').getByRole('checkbox', { name: "Don't change anything in this folder" }).check();
  }
  // The dialog's own button carries the same name as the one that opened it, so
  // the confirm has to be scoped to the dialog.
  await page.locator('.ui-modal').getByRole('button', { name: 'Add library' }).click();
  await expect(libraryRow(page, rootPath)).toBeVisible();
  // The fixture is the same ARW copied under several names, so every frame in it
  // is identical to every other and automatic stacking - correctly - collapses
  // the whole library into one tile. That is a property of the fixture rather
  // than of anything most specs are testing, so it is off unless a spec asks for
  // it; `stacks.spec.ts` is the one that does.
  //
  // Written once, not toggled off and back on by the specs that want it: the
  // control PATCHes and then re-reads the library list, so two of those in
  // flight together can land in either order and leave the setting wherever the
  // slower one put it.
  if (options.autoStack !== true) await setAutoStack(page, rootPath, false);
}

// Folders / renditions / stacks sit behind this disclosure so Settings stays
// short; open it before touching any of those controls.
async function openLibrarySettings(page: Page, rootPath: string): Promise<void> {
  const details = libraryRow(page, rootPath).locator('details.advanced').filter({ hasText: 'Library settings' });
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
  await expect(details).toHaveAttribute('open', '');
}

// The per-library "Group similar photos automatically" toggle (§19.4).
export async function setAutoStack(page: Page, rootPath: string, on: boolean): Promise<void> {
  await openLibrarySettings(page, rootPath);
  // Role rather than getByLabel: a Reset button next to a changed value shares
  // the setting's name in its accessible name and would steal the click.
  const toggle = libraryRow(page, rootPath).getByRole('checkbox', { name: 'Group similar photos automatically' });
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await expect(toggle).toBeChecked({ checked: on });
}

// Points a library at the pixels its renditions are built from. The control is a
// Select, whose trigger is a combobox named after the setting rather than a
// button named after the value, so the value is picked from the menu it opens.
export async function setRenditionSource(page: Page, rootPath: string, source: string): Promise<void> {
  await openLibrarySettings(page, rootPath);
  await libraryRow(page, rootPath).getByRole('combobox', { name: 'Build renditions from' }).click();
  await page.getByRole('option', { name: source }).click();
}

// Which rendition the photo viewer opens at, an app-wide setting rather than a
// per-library one. Same shape of control as above, and named for the question it
// answers rather than for the answer currently showing.
export async function setViewerRendition(page: Page, rendition: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Default rendition in photo viewer' }).click();
  await page.getByRole('option', { name: rendition, exact: true }).click();
}

export async function syncLibrary(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await libraryRow(page, rootPath).getByRole('button', { name: /Sync/ }).click();
}

// Waits on the Settings page until the run has finished and the catalogue has
// been re-read.
//
// The library's photo count is the signal because it is written by the same tick
// that notices the run has finished, so seeing it move means the client has
// re-read everything that tick re-reads. A spec that navigates away before then
// takes the grid it happens to catch mid-import: fine when it is only waiting
// for tiles, which arrive by announcement, and not fine when it is waiting on
// something that changes the shape of the collection (§19.4.1).
export async function waitForSyncSettled(page: Page, rootPath: string, photos: number): Promise<void> {
  await expect(libraryRow(page, rootPath)).toContainText(`${photos} photo`, { timeout: 60_000 });
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
//
// Waited for before it is clicked, so a rail that never fills names the library it was
// waiting for. A bare click reports only that a locator was still being waited on, which is
// the same message whether the page was slow, the library was never created, or an earlier
// test removed it - and under load this is where the suite lands when it lands anywhere.
//
// `timeout: 0` so the budget is the test's, which is what it already was. `use.actionTimeout`
// is unset, so the click this replaced waited the whole test timeout; `expect` would otherwise
// cap it at the config's 15s and make a slow rail fail *earlier* than it used to. The change
// is meant to be the message and nothing else.
export async function openLibrary(page: Page, rootPath: string): Promise<void> {
  const link = page.locator(`.rail__link[title="${rootPath}"]`);
  await expect(link, `the rail should list ${rootPath}`).toBeVisible({ timeout: 0 });
  await link.click();
}

// Maintenance actions on the selection live behind the bulk bar's overflow, so
// the bar's own row holds only what the selection becomes (§18.3.1).
export async function bulkAction(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name }).click();
}

// Row housekeeping lives behind the ⋮ menu; View photos is a double-click on the name.
export async function shootAction(page: Page, shootName: string, action: string): Promise<void> {
  await page.locator('.list__row', { hasText: shootName }).getByRole('button', { name: `Actions for ${shootName}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

export async function openShoot(page: Page, shootName: string): Promise<void> {
  await page.locator('.list__row', { hasText: shootName }).locator('.list__name').dblclick();
}

// A tile's frame selects on one click and opens the photo on two (§18.3.1), so
// every spec that wants the detail view goes through here rather than clicking.
export function openPhoto(page: Page, nth = 0): Promise<void> {
  return page.locator('.tile__hit').nth(nth).dblclick();
}

export function selectPhoto(page: Page, nth = 0): Promise<void> {
  return page.locator('.tile__hit').nth(nth).click();
}

// The viewer's URL also names the collection the photo was opened from, so the
// id is the last path segment rather than the tail of the whole URL.
export function openPhotoId(page: Page): string {
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

// Panels start closed; tests that read them have to ask. Waits for the toggle so
// a call right after openPhoto cannot no-op before DetailNav mounts, and skips
// the click when a prior toggle in this context already left them open.
export async function showMetadata(page: Page): Promise<void> {
  const show = page.getByRole('button', { name: 'Show metadata' });
  const hide = page.getByRole('button', { name: 'Hide metadata' });
  await expect(show.or(hide)).toBeVisible();
  if (await show.isVisible()) await show.click();
}

// Opens the first photo and swaps the rendition for the full-resolution render,
// which the server builds on first request.
export async function viewMaxQuality(page: Page, rootPath: string): Promise<void> {
  await page.goto('/settings');
  await openLibrary(page, rootPath);
  await openPhoto(page);
  // The full-size rendition is built by the background queue after a sync, so a
  // freshly synced library can wait on a real decode here.
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Rendition' }).click();
  await page.getByRole('menuitem', { name: 'Rendered RAW (max quality)' }).click();
  await showMetadata(page);
  await expect(page.locator('.panel', { hasText: 'RENDITION DETAILS' }).getByText('Rendered RAW (max quality)')).toBeVisible({
    timeout: 180_000,
  });
  // The stage holds the previous frame until the new one has decoded, so the
  // panel naming the rendition is not yet the image carrying it.
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveAttribute('src', /\/renditions\/max/, { timeout: 60_000 });
}

import { expect, test, type Page } from '@playwright/test';
import { PHONE_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, openPhoto, syncLibrary, waitForSyncSettled } from './helpers';

// A phone: no keyboard to step with and no room for a column beside the photo,
// which is what everything below is about.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test.describe.configure({ mode: 'serial' });

// Playwright's touchscreen taps and nothing else, and a mouse drag is a mouse
// however the context is configured, so a real finger is driven through CDP:
// what the stage answers to is pointer events, and only this produces them with
// the gesture handling a browser really applies to a touch.
async function swipe(page: Page, from: { x: number; y: number }, dx: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (const step of [0.3, 0.6, 1]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + dx * step, y: from.y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// The rail is a drawer here rather than a column, so it has to be pulled out
// before it can be navigated with.
async function openLibraryFromDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await openLibrary(page, PHONE_PHOTOS_DIR);
}

async function openFirstPhoto(page: Page): Promise<void> {
  await page.goto('/settings');
  await openLibraryFromDrawer(page);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
}

test('the phone library is indexed', async ({ page }) => {
  await addLibrary(page, PHONE_PHOTOS_DIR);
  await syncLibrary(page, PHONE_PHOTOS_DIR);
  await waitForSyncSettled(page, PHONE_PHOTOS_DIR, PHOTO_NAMES.length);
  await openLibraryFromDrawer(page);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });
});

test('swiping the frame steps to the next photo and back', async ({ page }) => {
  await openFirstPhoto(page);
  const first = page.url();

  const frame = page.locator('.stage__viewport');
  const box = await frame.boundingBox();
  if (box == null) throw new Error('the stage has no box');
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await swipe(page, middle, -160);
  await expect(page).not.toHaveURL(first);
  // Stepping is the whole gesture: a swipe that also read as a tap would land on
  // the next photo zoomed in.
  await expect(page.locator('.stage--zoomed')).toHaveCount(0);

  await swipe(page, middle, 160);
  await expect(page).toHaveURL(first);

  // A pointer is a pointer: the same drag with a mouse, which is what a narrow
  // desktop window has, steps the same way.
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x - 160, middle.y, { steps: 4 });
  await page.mouse.up();
  await expect(page).not.toHaveURL(first);
  await expect(page.locator('.stage--zoomed')).toHaveCount(0);
});

test('the verdict is on a bar at the foot of the window, with the rest under it', async ({ page }) => {
  await openFirstPhoto(page);

  const sheet = page.locator('.detail__sheet');
  await expect(sheet.getByRole('button', { name: 'Pick' })).toBeVisible();
  // Under the fold until asked for: the stars, and every panel of metadata.
  await expect(sheet.getByRole('button', { name: 'Set rating to 3' })).toHaveCount(0);
  await expect(sheet.locator('.panel')).toHaveCount(0);

  const bar = await sheet.boundingBox();
  const window = page.viewportSize();
  if (bar == null || window == null) throw new Error('the sheet has no box');
  expect(Math.round(bar.y + bar.height)).toBe(window.height);

  await sheet.getByRole('button', { name: 'Show details' }).click();
  await expect(sheet.getByRole('button', { name: 'Set rating to 3' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Pick' })).toBeVisible();

  await sheet.getByRole('button', { name: 'Hide details' }).click();
  await expect(sheet.locator('.panel')).toHaveCount(0);
});

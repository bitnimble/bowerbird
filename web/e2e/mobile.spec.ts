import { expect, test, type Page } from '@playwright/test';
import { PHONE_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, openPhoto, syncLibrary, waitForSyncSettled } from './helpers';

// A phone: no keyboard to step with and no room for a column beside the photo,
// which is what everything below is about.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// Serial because the library is set up once, and long because one spec opens a RAW: the decode
// is the same cold open `raw_editing.spec.ts` gives three minutes for, and the config's default
// 60s would kill it however patient the poll inside it is.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

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

/**
 * The crop tool under a finger, which is a different question from under a mouse.
 *
 * Three things a pointer test cannot ask. A grip has to be big enough to hit, and to be what a
 * finger actually lands on - the edit panel is a sheet across the foot of the window and the
 * grips a crop needs most are on the picture's bottom edge. The browser must not take the drag
 * for a scroll or a pinch, which is `touch-action`. And the stage's own one-finger pan is the
 * *same gesture* as dragging the rectangle, so it has to do nothing while the tool is open or
 * the photograph slides out from under a rectangle laid out for a fitted view.
 */
test('the crop rectangle takes a finger, and the stage does not pan under it', async ({ page }) => {
  await openFirstPhoto(page);
  const photoId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await page.goto(`/photos/${photoId}?edit=1`);
  await expect
    .poll(async () => page.getByTestId('raw-edit-panel').getAttribute('data-status'), { timeout: 170_000 })
    .toBe('live');

  await page.getByTestId('raw-edit-crop').click();
  const rect = page.getByTestId('crop-rect');
  // Opening the tool re-lays the page out - the panel empties, the sheet joins the flow, the
  // view resets - so the grip's box is only worth reading once that has happened.
  await expect(rect).toBeVisible();
  const grip = page.getByTestId('crop-grip-se');
  const box = await grip.boundingBox();
  if (box == null) throw new Error('the crop has no grip');
  // The target, not the mark: 44px is the smallest thing a finger reliably lands on.
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);

  const was = await rect.boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Nothing over it: the edit panel is a sheet across the foot of the window, and the grips a
  // crop needs most are on the picture's bottom edge, under exactly that.
  const at = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el == null ? 'nothing' : `${el.tagName}.${el.className}`;
    },
    [from.x, from.y],
  );
  expect(at, `something covers the grip at ${from.x},${from.y}`).toContain('crop-overlay__grip');
  await swipe(page, from, -120);

  // The rectangle moved, which is only true if the touch reached the grip rather than being
  // swallowed as a scroll.
  await expect
    .poll(async () => {
      const now = await rect.boundingBox();
      return now == null || was == null ? false : Math.abs(now.width - was.width) > 20;
    }, { timeout: 15_000 })
    .toBe(true);

  // And the photograph did not move under it. A drag outside the rectangle is the stage's own
  // pan gesture, which is the *same* one-finger drag the rectangle wants, so it has to do
  // nothing while the tool is open - and the region the tick draws is what says so, since a pan
  // is a change of region and nothing else.
  const region = page.getByTestId('raw-edit-region');
  const still = await region.textContent();
  const overlay = await page.getByTestId('crop-overlay').boundingBox();
  if (overlay == null) throw new Error('the crop has no overlay');
  // In the shade the drag above just made, which is outside the rectangle by construction.
  await swipe(page, { x: overlay.x + overlay.width / 2, y: overlay.y + overlay.height - 4 }, -120);
  expect(await region.textContent()).toBe(still);

  await page.getByTestId('raw-edit-cursor').click();
});

test('the header keeps to one line, its menus folded into an overflow button', async ({ page }) => {
  await openFirstPhoto(page);

  const nav = page.locator('.detail__nav');
  const control = await nav.locator('.ui-btn').first().boundingBox();
  const bar = await nav.boundingBox();
  if (control == null || bar == null) throw new Error('the header has no box');
  expect(bar.height).toBeLessThan(control.height * 2);

  await expect(nav.getByRole('button', { name: 'Download' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'More' }).click();
  // Every menu the bar had room for on a desktop, in the one popup.
  await expect(page.getByRole('menuitem', { name: 'Refresh metadata' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Original RAW' })).toBeVisible();
  // Out of the middle of a long popup: the one item that destroys something sits
  // at the foot of it, not a row above the next section's ordinary actions.
  await expect(page.getByRole('menuitem').last()).toHaveText('Move to Bin');
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

  await sheet.getByRole('button', { name: 'Show metadata' }).click();
  await expect(sheet.getByRole('button', { name: 'Set rating to 3' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Pick' })).toBeVisible();

  await sheet.getByRole('button', { name: 'Hide metadata' }).click();
  await expect(sheet.locator('.panel')).toHaveCount(0);
});

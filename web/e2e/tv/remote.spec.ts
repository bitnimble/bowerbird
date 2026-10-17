import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { TV_AGENT, TV_CONTROLS_SHOWN_MS } from '../../src/app/tv';
import { TV_PHOTOS_DIR } from '../fixture_library';
import { PathSegment, route } from '../../../src/schemas/route';
import {
  gallery,
  gotoLibrary,
  gotoPhoto,
  libraryPhotos,
  setHideSidebarInViewer,
  shownFrame,
  tiles,
  useLibrary,
} from '../helpers';

// A television's WebView: a 1080p panel at twice the density, and a remote rather than a pointer.
test.use({
  viewport: { width: 960, height: 540 },
  userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${TV_AGENT}`,
});

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, TV_PHOTOS_DIR);
});

function sidebar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Sidebar' });
}

// The library's row, ahead of its Photos row at the same address.
function currentLink(page: Page): Locator {
  return sidebar(page).locator('[aria-current="page"]').first();
}

function onPhoto(photoId: string): RegExp {
  return new RegExp(`${route(PathSegment.photos(), photoId)}$`);
}

/** What the shell does with the remote's Back: true where the page spent it. */
function back(page: Page): Promise<boolean> {
  return page.evaluate(() => window.bowerbirdBack!());
}

test('the remote opens a photo from the grid, steps through it, and backs out to the sidebar', async ({
  page,
  request,
}) => {
  // Hidden by the television, not by the setting it overrides.
  await setHideSidebarInViewer(request, false);
  const [first, second] = await libraryPhotos(page, TV_PHOTOS_DIR);
  await gotoLibrary(page, TV_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(2);

  await page.keyboard.press('ArrowDown');
  await expect(gallery(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(onPhoto(first!.id));
  await expect(shownFrame(page)).toBeVisible();
  await expect(sidebar(page)).toBeHidden();

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(onPhoto(second!.id));

  expect(await back(page)).toBe(true);
  await expect(page).not.toHaveURL(new RegExp(route(PathSegment.photos())));
  expect(await back(page)).toBe(true);
  await expect(currentLink(page)).toBeFocused();
  expect(await back(page)).toBe(false);
});

test('the arrows cross between the sidebar and the grid', async ({ page }) => {
  await gotoLibrary(page, TV_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(2);
  await currentLink(page).focus();

  await page.keyboard.press('ArrowRight');
  await expect(gallery(page)).toBeFocused();
  // The cursor marks the photo, so the grid itself draws no ring.
  await expect(gallery(page)).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('ArrowLeft');
  await expect(currentLink(page)).toBeFocused();
});

async function openFirstPhoto(page: Page): Promise<void> {
  await gotoLibrary(page, TV_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(shownFrame(page)).toBeVisible();
}

function bar(page: Page): Locator {
  return page.getByRole('group', { name: 'Photo controls' });
}

test('Enter brings up the bar and the filmstrip, which step and then go on Back', async ({
  page,
}) => {
  const [first, second] = await libraryPhotos(page, TV_PHOTOS_DIR);
  await openFirstPhoto(page);
  await expect(bar(page)).toBeHidden();

  await page.keyboard.press('Enter');
  await expect(bar(page)).toBeVisible();
  // The strip, which is the only collection on the viewer's screen.
  await expect(gallery(page)).toBeFocused();
  const edit = page
    .getByRole('link', { name: 'Edit' })
    .or(page.getByRole('button', { name: 'Edit' }));
  await expect(edit).toHaveCount(0);
  // The strip's cursor starts on the photograph already open, which Enter puts the controls away over.
  await page.keyboard.press('Enter');
  await expect(bar(page)).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(gallery(page)).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(onPhoto(first!.id));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(onPhoto(second!.id));
  await expect(bar(page)).toBeVisible();
  await expect(gallery(page)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(bar(page).locator(':focus')).toHaveCount(1);

  expect(await back(page)).toBe(true);
  await expect(bar(page)).toBeHidden();
  await expect(page).toHaveURL(onPhoto(second!.id));
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(onPhoto(first!.id));
});

test("Back closes the bar's menu and leaves the bar up", async ({ page }) => {
  await openFirstPhoto(page);
  await page.keyboard.press('Enter');
  const more = bar(page).getByRole('button', { name: 'More' });
  await more.focus();
  await page.keyboard.press('Enter');
  // Before the menu has taken the focus, which it does a frame after opening.
  await expect(more).toHaveAttribute('aria-expanded', 'true');

  expect(await back(page)).toBe(true);
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(bar(page)).toBeVisible();
});

test("the editor's address opens the photo to view", async ({ page }) => {
  await gotoPhoto(page, TV_PHOTOS_DIR, route(PathSegment.edit()));
  await expect(shownFrame(page)).toBeVisible();
  await expect(bar(page)).toBeHidden();
});

test("the remote picks another device's libraries in the connect dialog", async ({ page }) => {
  await page.route(
    `**${route(PathSegment.api(), PathSegment.replication(), PathSegment.replicas(), PathSegment.browse())}`,
    (request) =>
      request.fulfill({
        json: {
          peer_id: 'peer000000000001',
          name: 'Desktop',
          address: 'http://desktop:5173',
          clock_ms: Date.now(),
          clock_skew_ms: 0,
          libraries: [
            { id: 'library1', name: 'Trip', photo_count: 12, read_only: false, replicating: true },
            { id: 'library2', name: 'Home', photo_count: 3, read_only: false, replicating: true },
          ],
        },
      }),
  );
  await page.goto(route(PathSegment.settings(), 'libraries'));
  await page.getByRole('button', { name: 'Connect to another Bowerbird' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Connect to another Bowerbird' });
  await dialog.getByRole('textbox', { name: 'Device address' }).fill('http://desktop:5173');
  await page.keyboard.press('Enter');

  const trip = dialog.getByRole('checkbox', { name: 'Trip' });
  await expect(trip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trip).toBeChecked();
  await page.keyboard.press('ArrowDown');
  const home = dialog.getByRole('checkbox', { name: 'Home' });
  await expect(home).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(home).toBeChecked();
});

test('an arrow with nothing focused starts in the open dialog', async ({ page }) => {
  await page.goto(route(PathSegment.settings(), 'libraries'));
  await page.getByRole('button', { name: 'Connect to another Bowerbird' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect to another Bowerbird' });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  await page.keyboard.press('ArrowDown');
  await expect(dialog.locator(':focus')).toHaveCount(1);
});

test("the remote reaches the settings' sections and switches between them", async ({ page }) => {
  await page.goto(route(PathSegment.settings(), 'libraries'));
  await page.getByRole('button', { name: 'Add library' }).focus();

  await page.keyboard.press('ArrowUp');
  const sections = page.getByRole('radiogroup', { name: 'Settings sections' });
  await expect(sections.getByRole('radio', { name: 'Libraries' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(sections.getByRole('radio', { name: 'General' })).toBeChecked();
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.settings(), 'general')}$`));
});

test('the bar and the filmstrip go once the remote is left alone', async ({ page }) => {
  await page.clock.install();
  await openFirstPhoto(page);
  await page.keyboard.press('Enter');
  await expect(bar(page)).toBeVisible();

  await page.clock.fastForward(TV_CONTROLS_SHOWN_MS - 1000);
  await page.keyboard.press('ArrowRight');
  await page.clock.fastForward(TV_CONTROLS_SHOWN_MS - 1000);
  await expect(bar(page)).toBeVisible();
  await page.clock.fastForward(1000);
  await expect(bar(page)).toBeHidden();
});

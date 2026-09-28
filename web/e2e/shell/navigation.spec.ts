// The app around the photographs: where the home page lands, what a settings tab
// is as a URL, and what the sidebar becomes on a screen too narrow to keep it beside
// the content.
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHOTO_NAMES, SHELL_PHOTOS_DIR } from '../fixture_library';
import { gallery, gotoLibrary, openLibrary, setViewMode, setViewerRendition, tiles, useLibrary } from '../helpers';

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, SHELL_PHOTOS_DIR);
});

test('a settings tab is a link, and survives a reload and the back button', async ({ page }) => {
  await page.goto(route(PathSegment.settings(), 'advanced'));
  await expect(page.getByLabel('Colour fringing removal')).toBeVisible();

  await page.getByRole('radio', { name: 'General' }).click();
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.settings(), 'general')}$`));
  await expect(page.getByLabel('Daily full scan at')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Daily full scan at')).toBeVisible();

  await page.goBack();
  await expect(page.getByLabel('Colour fringing removal')).toBeVisible();

  // The bare path is still a link people have, and it opens what it always did.
  await page.goto(route(PathSegment.settings()));
  await expect(page.getByRole('button', { name: 'Add library' })).toBeVisible();
});

test('dropdowns show every option whenever the menu fits in the viewport', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1280, height: 300 },
    { width: 420, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    for (const mode of ['embedded', 'best_available'] as const) {
      await setViewerRendition(page.request, mode);
      await page.goto(route(PathSegment.settings(), 'general'));
      await page.getByRole('combobox', { name: 'Default rendition to show' }).click();

      const popup = page.getByRole('listbox');
      await expect(popup.getByRole('option')).toHaveCount(6);
      await expect.poll(() => popup.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
      await expect(popup.getByRole('option', { name: 'Embedded JPEG', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(popup.getByRole('option', { name: 'Best available', exact: true })).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
    }
  }
});

test('dropdowns align the selected row with the trigger when the whole menu fits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const [mode, label] of [['embedded', 'Embedded JPEG'], ['remember', 'Last used']] as const) {
    await setViewerRendition(page.request, mode);
    await page.goto(route(PathSegment.settings(), 'general'));
    const trigger = page.getByRole('combobox', { name: 'Default rendition to show' });
    await trigger.click();
    const popup = page.getByRole('listbox');
    const selected = popup.getByRole('option', { name: label, exact: true });
    const triggerCentre = await trigger.evaluate((element) => {
      const { top, height } = element.getBoundingClientRect();
      return top + height / 2;
    });

    await expect.poll(() => selected.evaluate((element) => {
      const { top, height } = element.getBoundingClientRect();
      return top + height / 2;
    })).toBeCloseTo(triggerCentre, 0);
    await expect.poll(() => popup.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    await expect(popup).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
  }
});

test('action menus use the whole viewport before scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await gotoLibrary(page, SHELL_PHOTOS_DIR);
  const trigger = page.getByRole('button', { name: 'Grid options', exact: true });
  await trigger.click();
  const popup = page.getByRole('menu');
  await expect(popup).toBeVisible();
  const height = await popup.evaluate((element) => element.scrollHeight + 20);
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1280, height });
  await trigger.click();
  await expect.poll(() => popup.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  await expect(popup.getByRole('menuitem', { name: 'Select all', exact: true })).toBeInViewport({ ratio: 1 });
  await expect(popup.getByRole('menuitemcheckbox', { name: 'Expand all stacks', exact: true })).toBeInViewport({ ratio: 1 });
});

test('filter dropdown panels use the whole viewport before scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 1200 });
  await gotoLibrary(page, SHELL_PHOTOS_DIR);
  const trigger = page.getByRole('button', { name: 'Filters', exact: true });
  await trigger.click();
  const popup = page.getByRole('dialog');
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Camera body', exact: true })).toBeVisible();
  const viewport = await popup.evaluate((element) => ({
    width: Math.ceil(element.getBoundingClientRect().width) + 20,
    height: element.scrollHeight + 20,
  }));
  await page.keyboard.press('Escape');

  await page.setViewportSize(viewport);
  await trigger.click();
  await expect.poll(() => popup.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
  await expect(popup).toBeInViewport({ ratio: 1 });
});

test('dropdowns taller than the viewport still scroll and allow selection', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 160 });
  await setViewerRendition(page.request, 'best_available');
  await page.goto(route(PathSegment.settings(), 'general'));
  const trigger = page.getByRole('combobox', { name: 'Default rendition to show' });
  await trigger.click();
  const popup = page.getByRole('listbox');
  await expect.poll(() => popup.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  await expect(popup).toBeInViewport({ ratio: 1 });

  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(popup).toBeHidden();
  await expect(trigger).toHaveText('Embedded JPEG');
});

test('the home page lands in a library, and a narrow screen gets the sidebar as a drawer', async ({ page }) => {
  await page.goto(route());
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.libraries())}/`));

  // Which library that was is the run's business - the home page takes the first
  // by root path, so it is whichever spec's root sorts first. The measurements
  // below are of photographs, so they are made in this spec's own library rather
  // than in whatever the walk happened to land on.
  await openLibrary(page, SHELL_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  // Rows, so grid: what is measured below is the window's own bottom inset, and
  // masonry packs these two photographs into a line short enough not to scroll at all.
  await setViewMode(page, 'Grid');

  await page.setViewportSize({ width: 420, height: 800 });
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' });
  // Mounted but slid off the left, so it is a question of visibility rather than of presence.
  await expect(sidebar).not.toBeVisible();

  // The toggle takes room in the first control row, not a column of its own: the
  // photographs below it get the whole width of the phone.
  const toggle = page.getByRole('button', { name: 'Show sidebar' });
  const toggleBox = (await toggle.boundingBox())!;
  const tileBox = (await tiles(page).first().boundingBox())!;
  expect(tileBox.x).toBeLessThan(toggleBox.x + toggleBox.width);

  // And the whole height of it: the page's bottom inset was outside the scroller,
  // so it was a strip of window no photograph could reach and the last row was cut
  // off above it.
  const scroller = gallery(page);
  const scrollerBox = (await scroller.boundingBox())!;
  expect(scrollerBox.y + scrollerBox.height).toBeCloseTo(800, 0);

  // The inset itself is inside the scroll, so at the end of it the last row clears
  // the window by a pad instead of sitting against it. A window short enough that a
  // couple of photographs scroll at all.
  await page.setViewportSize({ width: 420, height: 460 });
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const last = tiles(page).last();
  await expect
    .poll(async () => {
      const box = (await last.boundingBox())!;
      return Math.round(box.y + box.height);
    })
    .toBe(460 - 20);
  await page.setViewportSize({ width: 420, height: 800 });

  await toggle.click();
  await expect(sidebar).toBeVisible();

  // Over the content rather than beside it: the page keeps the full width it had. Polled,
  // because the drawer eases in from off the left rather than appearing where it lands.
  const contentBox = (await page.getByRole('main').boundingBox())!;
  await expect
    .poll(async () => {
      const box = await sidebar.boundingBox();
      return box == null ? 0 : box.x + box.width;
    })
    .toBeGreaterThan(contentBox.x);

  // Navigating is what the drawer was opened for, so it closes behind the link.
  await page.getByRole('link', { name: 'Albums' }).click();
  // Mounted but slid off the left, so it is a question of visibility rather than of presence.
  await expect(sidebar).not.toBeVisible();
});

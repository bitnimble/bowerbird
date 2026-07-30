import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, addShoot, bulkAction, openLibrary, openPhoto, selectPhoto, syncLibrary } from './helpers';

// One ordered journey: each step depends on the catalogue state the previous one
// produced, which is also how the bugs below were originally found.
test.describe.configure({ mode: 'serial' });

test('indexes a library and shows a rendition for every RAW file', async ({ page }) => {
  await addLibrary(page, PHOTOS_DIR);
  await syncLibrary(page, PHOTOS_DIR);
  await openLibrary(page, PHOTOS_DIR);

  // Longer than the configured 15s default: unlike the other assertions, this one
  // waits on a real scan (LibRaw opens every new file), so it scales with the
  // fixture and the machine rather than with the UI.
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });

  // Regression: renditions are requested before processing has written them, so
  // the first request 404s, and the tile has nothing to do but wait for the
  // server to say its photo is built. Every tile must end up showing decoded
  // pixels, and none may be left on the placeholder.
  await expect
    .poll(
      async () =>
        page.locator('.tile img').evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length),
      { timeout: 45_000 },
    )
    .toBe(PHOTO_NAMES.length);
  await expect(page.locator('.tile__pending')).toHaveCount(0);
});

test('the sort follows the collection rather than the browser it was set in', async ({ page }) => {
  // The point of storing it on the collection: clearing this browser's state is
  // what a second device looks like, and the sort has to survive it. Held in
  // localStorage, as it was, the reload below came back sorted by the default.
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  const sort = page.getByRole('combobox', { name: 'Sort photos' });
  await expect(sort).toHaveText('Oldest first');

  await sort.click();
  await page.getByRole('option', { name: 'Recently added' }).click();
  await expect(sort).toHaveText('Recently added');

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await openLibrary(page, PHOTOS_DIR);
  await expect(sort).toHaveText('Recently added');

  // Put it back, so the ordered journey the rest of this file depends on carries
  // on in the order it expects.
  await sort.click();
  await page.getByRole('option', { name: 'Oldest first' }).click();
  await expect(sort).toHaveText('Oldest first');
});

test('keeps the library in the shell when a shoot is opened by deep link', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();

  // The library root is a permanent row carrying what sits outside every shoot,
  // so a library with photos and no shoots is never an empty page.
  const root = page.locator('.list__row--root');
  await expect(root).toBeVisible();
  await expect(root).toContainText('in no shoot');

  await addShoot(page, 'Reef');
  await expect(page.locator('.list__name', { hasText: 'Reef' })).toBeVisible();

  const shootHref = await page.getByRole('link', { name: 'View photos' }).first().getAttribute('href');
  expect(shootHref).not.toBeNull();

  // Regression: /shoots/:id carries no library id, so the rail used to blank out
  // and the user lost every way back into the library.
  await page.goto(shootHref!);
  await expect(page.locator('.rail__link', { hasText: 'Bin' })).toBeVisible();
  await expect(page.locator('.rail__link', { hasText: 'Shoots' })).toBeVisible();
  await expect(page.locator(`.rail__link[title="${PHOTOS_DIR}"]`)).toBeVisible();
});

// The rows are virtualised, so a row scrolled out of the window is unmounted and
// anything focused inside it used to fall to the document body - the next Tab
// then restarted at the top of the page. The cursor is a value in the store, so
// it survives that, and exactly one row is ever in the tab order.
test('the folder list is walkable by keyboard, and Tab lands on the cursor', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();
  await addShoot(page, 'Kelp');
  await expect(page.locator('.list__name', { hasText: 'Kelp' })).toBeVisible();

  // Nothing is cursored until the reader asks for one.
  await expect(page.locator('.list__row--cursored')).toHaveCount(0);

  // Onto the list first: closing the dialog hands focus back to the + menu, and
  // a menu owns the arrow keys while it has focus - as it should.
  await page.locator('.list__scroller').focus();

  // Rows are ordered by folder path, so Kelp comes before Reef.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.list__row--cursored')).toHaveCount(1);
  await expect(page.locator('.list__row--cursored')).toContainText('Kelp');

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.list__row--cursored')).toContainText('Reef');

  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.list__row--cursored')).toContainText('Kelp');

  // One tab stop for the whole list, and it is the cursor.
  await expect(page.locator('.list__row[tabindex="0"]')).toHaveCount(1);
  await expect(page.locator('.list__row[tabindex="0"]')).toContainText('Kelp');

  // Clicking a row moves the cursor to it, because that is the reader choosing.
  await page.locator('.list__row', { hasText: 'Reef' }).locator('.list__name').click();
  await expect(page.locator('.list__row--cursored')).toContainText('Reef');

  // Merely *focusing* one does not: focus arrives at rows for reasons that are
  // not a choice, and the cursor is the reader's place.
  await page.locator('.list__row', { hasText: 'Kelp' }).getByRole('button', { name: 'Rename' }).focus();
  await expect(page.locator('.list__row--cursored')).toContainText('Reef');

  // Put the list back as it was found: the rest of this file is one ordered
  // journey through a single library. Deleting the shoot and keeping its photos
  // is the reversible half of the dialog, which nothing else exercises.
  await page.locator('.list__row', { hasText: 'Kelp' }).getByRole('button', { name: 'Delete' }).click();
  await page.locator('.ui-modal').getByRole('button', { name: 'Delete shoot' }).click();
  await expect(page.locator('.list__name', { hasText: 'Kelp' })).toHaveCount(0);
});

// The actual regression, which needs more rows than fit on screen: the list must
// hold the reader's place when the row they were in stops existing.
test('a cursor survives the row under it being unmounted by a scroll', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();

  const made = Array.from({ length: 30 }, (_, i) => `Deep${String(i).padStart(2, '0')}`);
  for (const name of made) await addShoot(page, name);
  await expect(page.locator('.list__row')).not.toHaveCount(made.length + 1); // virtualised: fewer mounted than exist

  await page.locator('.list__scroller').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.list__row--cursored')).toContainText('Deep00');

  // Focus something inside the cursored row, then scroll it far out of the window.
  await page.locator('.list__row--cursored').getByRole('button', { name: 'Rename' }).focus();
  await page.locator('.list__scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('.list__row', { hasText: 'Deep00' })).toHaveCount(0); // unmounted

  // Focus went back to the list rather than to the document body, so the next
  // Tab continues from here instead of restarting at the top of the page.
  await expect(page.locator('.list__scroller')).toBeFocused();

  // Tabbing forward reaches a row that is actually on screen, and does NOT move
  // the cursor: the reader's place is kept until they ask for it to move.
  await page.keyboard.press('Tab');
  await expect(page.locator('.list__scroller')).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  await expect(page.locator('.list__row--cursored')).toHaveCount(0); // still Deep00, still unmounted

  // And it is genuinely still there: arrowing brings it back rather than starting
  // over at the top of a list the reader was thirty rows into.
  await page.locator('.list__scroller').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.list__row--cursored')).toContainText('Deep01');
  await expect(page.locator('.list__row--cursored')).toBeVisible();

  for (const name of made) {
    await page.locator('.list__row', { hasText: name }).getByRole('button', { name: 'Delete' }).click();
    await page.locator('.ui-modal').getByRole('button', { name: 'Delete shoot' }).click();
    await expect(page.locator('.list__name', { hasText: name })).toHaveCount(0);
  }
});

test('adding a photo to a shoot moves the file out of the library root on disk', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await selectPhoto(page);
  // The count only appears past one photo, since below that the ring says it.
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await expect(page.locator('.bulkbar__count')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add to shoot' }).click();
  await page.getByRole('menuitemcheckbox', { name: /Reef/ }).click();

  await page.getByRole('link', { name: 'Shoots', exact: true }).click();
  await page.getByRole('link', { name: 'View photos' }).first().click();
  await expect(page.locator('.tile')).toHaveCount(1);

  // A shoot is a real folder, so the add is a file move, not just a DB flag.
  const inShoot = readdirSync(`${PHOTOS_DIR}/Reef`).filter((f) => f.endsWith('.arw'));
  expect(inShoot).toHaveLength(1);
  const atRoot = readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.arw'));
  expect(atRoot).toHaveLength(PHOTO_NAMES.length - 1);
  expect(atRoot).not.toContain(inShoot[0]);
});

// The way out of the viewer is the grid the reader came in by: a photo opened
// from a shoot returns to the shoot, not to the library it happens to live in.
test('leaving a photo returns to the collection it was opened from', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();
  await page.getByRole('link', { name: 'View photos' }).first().click();
  await expect(page.locator('.tile')).toHaveCount(1);
  const shoot = page.url();

  await openPhoto(page);
  await expect(page).toHaveURL(/\/photos\//);
  const back = page.locator('.detail__nav').getByRole('link', { name: 'Shoot', exact: true });
  // Named for where it goes, so it is not offering "Library" from inside a shoot.
  await expect(back).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(shoot);

  await openPhoto(page);
  await expect(page).toHaveURL(/\/photos\//);
  await back.click();
  await expect(page).toHaveURL(shoot);
});

test('a photo can be taken back out of a shoot', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await page.getByRole('link', { name: 'Shoots', exact: true }).click();
  await page.getByRole('link', { name: 'View photos' }).first().click();
  await expect(page.locator('.tile')).toHaveCount(1);

  // Removal goes over DELETE with a JSON body (§13.3). Hono/Bun do parse that,
  // but nothing exercised it until the remove button existed, so pin it here:
  // a dropped body would silently no-op and leave the photo in the shoot.
  await selectPhoto(page);
  await page.getByRole('button', { name: /^Remove from / }).click();

  await expect(page.locator('.tile')).toHaveCount(0);
  const atRoot = readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.arw'));
  expect(atRoot).toHaveLength(PHOTO_NAMES.length);
});

test('masonry lays photos out across a row, not down a column', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  await page.getByRole('button', { name: 'Masonry', exact: true }).click();

  // Regression: laid out with CSS columns, the tiles ran down the first column
  // before starting the second, which a paged or infinite list cannot do - it
  // has no bottom to fill to. They now sit on a row of one height, which is the
  // zoom size: under columns the height was whatever the column's width made it.
  const box = async (i: number) => (await page.locator('.tile').nth(i).boundingBox())!;
  const zoom = await page.locator('.grid').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--tile')));
  const first = await box(0);
  const second = await box(1);
  expect(second.y).toBeCloseTo(first.y, 0);
  expect(first.height).toBeCloseTo(zoom, 0);
  expect(second.height).toBeCloseTo(first.height, 0);

  await page.getByRole('button', { name: 'Grid', exact: true }).click();
});

test('the bin shows only soft-deleted photos, and the library hides them', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await selectPhoto(page);
  await bulkAction(page, 'Move to Bin');
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  // Regression: include_deleted alone returns live + deleted, so the Bin showed
  // the whole library. It needs the is_deleted filter to mean "only the Bin".
  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.badge--deleted')).toHaveCount(1);
});

test('the home page lands in a library, and a narrow screen gets the rail as a drawer', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/libraries\//);

  await page.setViewportSize({ width: 420, height: 800 });
  const rail = page.locator('.rail');
  await expect(rail).toHaveCount(0);

  // The toggle takes room in the first control row, not a column of its own: the
  // photographs below it get the whole width of the phone.
  const toggle = page.getByRole('button', { name: 'Show sidebar' });
  const toggleBox = (await toggle.boundingBox())!;
  const tileBox = (await page.locator('.tile').first().boundingBox())!;
  expect(tileBox.x).toBeLessThan(toggleBox.x + toggleBox.width);

  // And the whole height of it: the page's bottom inset was outside the scroller,
  // so it was a strip of window no photograph could reach and the last row was cut
  // off above it.
  const scroller = page.locator('.grid__scroller');
  const scrollerBox = (await scroller.boundingBox())!;
  expect(scrollerBox.y + scrollerBox.height).toBeCloseTo(800, 0);

  // The inset itself is inside the scroll, so at the end of it the last row clears
  // the window by a pad instead of sitting against it. A window short enough that a
  // couple of photographs scroll at all.
  await page.setViewportSize({ width: 420, height: 460 });
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const last = page.locator('.tile').last();
  await expect
    .poll(async () => {
      const box = (await last.boundingBox())!;
      return Math.round(box.y + box.height);
    })
    .toBe(460 - 20);
  await page.setViewportSize({ width: 420, height: 800 });

  await toggle.click();
  await expect(rail).toBeVisible();

  // Over the content rather than beside it: the page keeps the full width it had.
  const railBox = (await rail.boundingBox())!;
  const contentBox = (await page.locator('.content').boundingBox())!;
  expect(contentBox.x).toBeLessThan(railBox.x + railBox.width);

  // Navigating is what the drawer was opened for, so it closes behind the link.
  await page.getByRole('link', { name: 'Albums' }).click();
  await expect(rail).toHaveCount(0);
});

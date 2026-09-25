// Shoots, which are real folders on disk: making one, walking the list of them,
// moving photographs in and out, and where the viewer goes back to when a photo
// was opened from one.
import { readdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import {
  addShoot,
  bulkAction,
  collectionList,
  fileIntoShoot,
  openLibrary,
  openPhoto,
  openShoot,
  selectedTiles,
  selectionCount,
  shootRow,
  sidebarLibrary,
  sidebarSection,
  selectPhoto,
  shootAction,
  tiles,
  useLibrary,
} from '../helpers';

// One ordered journey: each step depends on the catalogue state the previous one
// produced, which is also how the bugs below were originally found.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, PHOTOS_DIR);
});

const rows = (page: Page) => collectionList(page).getByRole('listitem');
const cursored = (page: Page) => collectionList(page).locator('[role="listitem"][aria-current="true"]');

test('keeps the library in the shell when a shoot is opened by deep link', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();

  // The library root is a permanent row, and the photographs no shoot has claimed
  // lead the list, so a library with photos and no shoots is never an empty page.
  await expect(page.getByRole('button', { name: 'Add to the library root' })).toBeVisible();
  const orphans = rows(page).filter({ hasText: 'Not in any shoot' });
  await expect(orphans).toContainText(`Not in any shoot (${PHOTO_NAMES.length} photos)`);

  await orphans.getByText('Not in any shoot').click();
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.noShoot())}$`));
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();

  await addShoot(page, 'Reef');
  await expect(rows(page).getByText('Reef', { exact: true })).toBeVisible();

  await openShoot(page, 'Reef');
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.shoots())}/`));
  const shootHref = page.url();

  // A deep link straight to /shoots/:id still has to load the libraries the sidebar
  // lists, so there is a way back into the library.
  await page.goto(route());
  await page.goto(shootHref);
  await expect(sidebarSection(page, PHOTOS_DIR, 'Bin')).toBeVisible();
  await expect(sidebarSection(page, PHOTOS_DIR, 'Shoots')).toBeVisible();
  await expect(sidebarLibrary(page, PHOTOS_DIR)).toBeVisible();
});

// The rows are virtualised, so a row scrolled out of the window is unmounted and
// anything focused inside it used to fall to the document body - the next Tab
// then restarted at the top of the page. The cursor is a value in the store, so
// it survives that, and exactly one row is ever in the tab order.
test('the folder list is walkable by keyboard, and Tab lands on the cursor', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();
  await addShoot(page, 'Kelp');
  await expect(rows(page).getByText('Kelp', { exact: true })).toBeVisible();

  // Nothing is cursored until the reader asks for one.
  await expect(cursored(page)).toHaveCount(0);

  // Onto the list first: closing the dialog hands focus back to the + menu, and
  // a menu owns the arrow keys while it has focus - as it should.
  await collectionList(page).focus();

  // The photographs in no shoot lead the list; the shoots below them are ordered
  // by folder path, so Kelp comes before Reef.
  await page.keyboard.press('ArrowDown');
  await expect(cursored(page)).toHaveCount(1);
  await expect(cursored(page)).toContainText('Not in any shoot');

  await page.keyboard.press('ArrowDown');
  await expect(cursored(page)).toContainText('Kelp');
  // Cursor move takes DOM focus with it, so Enter opens this row.
  await expect(cursored(page)).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(cursored(page)).toContainText('Reef');
  await expect(cursored(page)).toBeFocused();

  await page.keyboard.press('ArrowUp');
  await expect(cursored(page)).toContainText('Kelp');
  await expect(cursored(page)).toBeFocused();
  // The ring is drawn for the keyboard and for nobody else.
  expect(await cursored(page).evaluate((row) => row.matches(':focus-visible'))).toBe(true);

  // One tab stop for the whole list, and it is the cursor.
  const tabStop = collectionList(page).locator('[role="listitem"][tabindex="0"]');
  await expect(tabStop).toHaveCount(1);
  await expect(tabStop).toContainText('Kelp');

  // Merely *focusing* a row does not move the cursor: focus arrives at rows for
  // reasons that are not a choice, and the cursor is the reader's place.
  await shootRow(page, 'Reef').getByRole('button', { name: 'Actions for Reef' }).focus();
  await expect(cursored(page)).toContainText('Kelp');

  // One click on a row opens it.
  await openShoot(page, 'Reef');
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.shoots())}/`));
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();

  // Put the list back as it was found: the rest of this file is one ordered
  // journey through a single library. Deleting the shoot and keeping its photos
  // is the reversible half of the dialog, which nothing else exercises.
  await shootAction(page, 'Kelp', 'Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete shoot' }).click();
  await expect(rows(page).getByText('Kelp', { exact: true })).toHaveCount(0);
});

// The actual regression, which needs more rows than fit on screen: the list must
// hold the reader's place when the row they were in stops existing.
test('a cursor survives the row under it being unmounted by a scroll', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();

  const made = Array.from({ length: 30 }, (_, i) => `Deep${String(i).padStart(2, '0')}`);
  for (const name of made) await addShoot(page, name);
  await expect(rows(page)).not.toHaveCount(made.length + 1); // virtualised: fewer mounted than exist

  await collectionList(page).focus();
  await page.keyboard.press('ArrowDown'); // the photographs in no shoot, which lead the list
  await page.keyboard.press('ArrowDown');
  await expect(cursored(page)).toContainText('Deep00');

  // Focus something inside the cursored row, then scroll it far out of the window.
  await cursored(page).getByRole('button', { name: 'Actions for Deep00' }).focus();
  await collectionList(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(shootRow(page, 'Deep00')).toHaveCount(0); // unmounted

  // Focus went back to the list rather than to the document body, so the next
  // Tab continues from here instead of restarting at the top of the page.
  await expect(collectionList(page)).toBeFocused();

  // Tabbing forward reaches a row that is actually on screen, and does NOT move
  // the cursor: the reader's place is kept until they ask for it to move.
  await page.keyboard.press('Tab');
  await expect(collectionList(page)).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  await expect(cursored(page)).toHaveCount(0); // still Deep00, still unmounted

  // And it is genuinely still there: arrowing brings it back rather than starting
  // over at the top of a list the reader was thirty rows into.
  await collectionList(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(cursored(page)).toContainText('Deep01');
  await expect(cursored(page)).toBeVisible();

  for (const name of made) {
    await shootAction(page, name, 'Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete shoot' }).click();
    await expect(rows(page).getByText(name, { exact: true })).toHaveCount(0);
  }
});

test('adding a photo to a shoot moves the file out of the library root on disk', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  await selectPhoto(page);
  await expect(selectedTiles(page)).toHaveCount(1);
  await expect(selectionCount(page)).toHaveText('1 selected');
  await fileIntoShoot(page, 'Reef');

  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();
  await openShoot(page, 'Reef');
  await expect(tiles(page)).toHaveCount(1);

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
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();
  await openShoot(page, 'Reef');
  await expect(tiles(page)).toHaveCount(1);
  const shoot = page.url();

  await openPhoto(page);
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.photos())}/`));
  const back = page.getByRole('group', { name: 'Photo controls' }).getByRole('link', { name: 'Shoot', exact: true });
  // Named for where it goes, so it is not offering "Library" from inside a shoot.
  await expect(back).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(shoot);

  await openPhoto(page);
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.photos())}/`));
  await back.click();
  await expect(page).toHaveURL(shoot);

  // The collection is in the URL, so a reload does not quietly turn the way out
  // into the whole library.
  await openPhoto(page);
  await page.reload();
  await expect(back).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(shoot);
});

test('a photo can be taken back out of a shoot', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();
  await openShoot(page, 'Reef');
  await expect(tiles(page)).toHaveCount(1);

  // Removal goes over DELETE with a JSON body (§13.3). Hono/Bun do parse that,
  // but nothing exercised it until the remove button existed, so pin it here:
  // a dropped body would silently no-op and leave the photo in the shoot.
  await selectPhoto(page);
  await bulkAction(page, 'Remove from Reef');

  await expect(tiles(page)).toHaveCount(0);
  const atRoot = readdirSync(PHOTOS_DIR).filter((f) => f.endsWith('.arw'));
  expect(atRoot).toHaveLength(PHOTO_NAMES.length);
});

// Last, because it renames the shoot the rest of this journey opens by name.
test('the title of a shoot is the rename control, and refuses a name no folder could have', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PHOTOS_DIR);
  await sidebarSection(page, PHOTOS_DIR, 'Shoots').click();
  await openShoot(page, 'Reef');

  await page.getByRole('heading', { name: 'Reef' }).getByRole('button').click();
  const field = page.getByRole('textbox', { name: 'Rename Reef' });
  await field.fill('a/b');
  await expect(page.getByText('Enter a folder name without slashes or a leading dot.')).toBeVisible();
  await field.press('Enter');
  await expect(field).toBeVisible();

  await field.fill('Reef Break');
  await field.press('Enter');
  await expect(page.getByRole('heading', { name: 'Reef Break' })).toBeVisible();
  // The folder is what a shoot is, so only the label moved (§4.3).
  expect(readdirSync(PHOTOS_DIR)).toContain('Reef');
});

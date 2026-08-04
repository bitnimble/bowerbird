import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL, CULL_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import {
  addLibrary,
  bulkAction,
  openLibrary,
  openPhoto,
  openPhotoId,
  selectPhoto,
  setRenditionSource,
  setViewerRendition,
  showMetadata,
  syncLibrary,
  viewMaxQuality,
} from './helpers';

// This spec has its own library root, so binning and rejecting here cannot
// disturb the counts the other spec asserts.
test.describe.configure({ mode: 'serial' });

test('sync indexes the cull library', async ({ page }) => {
  await addLibrary(page, CULL_PHOTOS_DIR);
  await syncLibrary(page, CULL_PHOTOS_DIR);
  await openLibrary(page, CULL_PHOTOS_DIR);
  // Waits on a real scan, so it needs longer than the configured 15s default.
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });
});

test('rating and picking work from the grid without opening a photo', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // Arrow to the first tile, rate it, pick it. The whole point is that culling
  // never requires a round trip through the detail view.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await page.keyboard.press('4');
  await page.keyboard.press('c');

  const first = page.locator('.tile').first();
  await expect(first.locator('.verdict__btn--pick.is-on')).toBeVisible();
  await expect(first.locator('.rating button.on')).toHaveCount(4);

  // The verdict survives a reload, so it was persisted rather than only shown.
  await page.reload();
  await expect(first.locator('.rating button.on')).toHaveCount(4);
  await expect(first.locator('.verdict__btn--pick.is-on')).toBeVisible();
});

test('the verdict and rating on a tile are clickable, and clicking again clears them', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  const tile = page.locator('.tile').nth(1);

  // Setting a verdict from the grid must not open the photo: these controls are
  // the whole reason a cull does not need the detail view.
  await tile.getByRole('button', { name: 'Pick' }).click();
  await expect(tile.locator('.verdict__btn--pick.is-on')).toBeVisible();
  expect(page.url()).not.toContain('/photos/');

  await tile.getByRole('button', { name: 'Clear pick' }).click();
  await expect(tile.locator('.verdict__btn--pick.is-on')).toHaveCount(0);

  await tile.getByRole('button', { name: 'Set rating to 3' }).click();
  await expect(tile.locator('.rating button.on')).toHaveCount(3);
  // Clicking the star it already sits on is how a rating is removed.
  await tile.getByRole('button', { name: 'Set rating to 3' }).click();
  await expect(tile.locator('.rating button.on')).toHaveCount(0);
});

test('rejecting removes a photo from the default working set', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // The gallery opens on Active (untriaged + picked), so a reject should leave
  // the view immediately rather than lingering in the set being worked through.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  await page.getByRole('button', { name: 'Rejects', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.verdict__btn--reject.is-on')).toHaveCount(1);

  // Undo the reject so later tests see the full set again.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

// The frame belongs to the selection: choosing photographs is what a grid is
// mostly for, and opening one is the second click (§18.3.1).
test('a click selects the photo alone and a double-click opens it', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  const tiles = page.locator('.tile');

  await selectPhoto(page, 0);
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  expect(page.url()).not.toContain('/photos/');

  // "That one instead", not "that one as well": a second plain click replaces the
  // selection rather than adding to it, and cmd-click is what builds a set.
  await selectPhoto(page, 1);
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await expect(tiles.last()).toHaveClass(/tile--selected/);
  await tiles.first().locator('.tile__hit').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.tile--selected')).toHaveCount(2);

  // Regression: cmd-clicking a selected photo moves the cursor onto the very photo
  // it deselects, and a ring drawn for the cursor as well as for the selection left
  // that photo ringed with nothing about to act on it.
  await tiles.first().locator('.tile__hit').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await expect(tiles.first()).not.toHaveClass(/tile--selected/);

  // The ring is the selection, so dropping it leaves nothing ringed at all.
  await page.keyboard.press('Escape');
  await expect(page.locator('.tile--selected')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More actions' })).toBeDisabled();

  await openPhoto(page, 0);
  await expect(page).toHaveURL(/\/photos\//);
});

test('Enter opens the photo the cursor is on', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // Arrived by clicking the rail link, so the focus is on that link until the
  // first arrow key hands it to the grid - without which Enter belongs to the
  // link and the cull's own "open" is dead.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/photos\//);
});

// Picking a burst out of a shoot is a range, not forty clicks.
test('shift-click extends the selection from the anchor', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  const tiles = page.locator('.tile');
  // Anchored on the last tile and then cleared, so a range that reaches it is
  // the only way the count can come back: the anchor is where the range starts
  // from, not what happens to be selected.
  await tiles.last().locator('.tile__hit').click();
  await tiles.last().locator('.tile__hit').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.tile--selected')).toHaveCount(0);

  await tiles.first().locator('.tile__hit').click({ modifiers: ['Shift'] });
  await expect(page.locator('.tile--selected')).toHaveCount(PHOTO_NAMES.length);

  // And it does not open the photo on the way.
  expect(page.url()).not.toContain('/photos/');

  // The cursor answers for the anchor when nothing has been toggled: arrow to a
  // photo, shift-click another, get everything between them. ArrowLeft rather
  // than Right because the cursor is wherever the clicks above left it, and
  // moving it is clamped at the first tile.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.locator('.tile--selected')).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(tiles.first()).toHaveClass(/tile--selected/);
  await tiles.last().locator('.tile__hit').click({ modifiers: ['Shift'] });
  await expect(page.locator('.tile--selected')).toHaveCount(PHOTO_NAMES.length);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
});

test('the Picks filter narrows to what was picked', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.getByRole('button', { name: 'Picks', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('filename search finds a single frame', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.getByLabel('Find by filename').fill('alpha');
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.tile__name').first()).toHaveText('alpha.arw');
});

test('a search cleared from outside the box stays cleared', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  const box = page.getByLabel('Find by filename');

  await box.fill('alpha');
  await expect(page.locator('.tile')).toHaveCount(1);

  // Regression: the box kept its own copy of the text and its debounce compared
  // that stale copy against the freshly emptied store, writing the old search
  // back 250ms later. Opening another collection resets the filters, which is
  // exactly that external clear. Waiting past the debounce is the point.
  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(box).toHaveValue('');
  await page.waitForTimeout(600);
  await expect(box).toHaveValue('');
  await expect(page.locator('.tile')).toHaveCount(0);
});

test('the Custom filter unions its options instead of intersecting them', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // A preset is a named point in the same space as Custom, so it arrives with
  // its own options already ticked. Start from All, which ticks nothing, or the
  // clicks below would be toggling the Active preset's boxes off.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: /^Custom/ }).click();
  await expect(page.getByRole('menuitemcheckbox', { checked: true })).toHaveCount(0);

  // One photo is picked and rated by an earlier test; the rest are neither. As an
  // intersection "picks AND unrated" is empty, so a union is the only reading
  // that returns the whole set.
  await page.getByRole('menuitemcheckbox', { name: 'Picks' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Unrated' }).click();
  await page.keyboard.press('Escape');

  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('a preset filter arrives with its options already ticked in Custom', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // Active is untriaged + picked, so Custom must show exactly those two ticked
  // rather than looking as though no filter were applied.
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.getByRole('button', { name: /^Custom/ }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Untriaged', checked: true })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Picks', checked: true })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Rejects', checked: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Delete bins the focused photo and the toast undoes it', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  // Wait for the grid: a keypress before the photos land finds nothing to focus.
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  const binned = await page.locator('.tile__name').first().innerText();
  await page.keyboard.press('Delete');

  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);
  await expect(page.getByText('1 photo moved to the Bin')).toBeVisible();

  // Undo must actually put it back, not just dismiss the toast.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  await expect(page.locator('.tile__name', { hasText: binned })).toBeVisible();
});

test('restoring from the Bin returns the photo to the library', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);

  await selectPhoto(page);
  await bulkAction(page, 'Move to Bin');
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  // Regression: the Bin used to hold rendition-less grey boxes because
  // soft-delete removed the WebPs, making it impossible to find anything.
  await expect(page.locator('.tile__pending')).toHaveCount(0);

  // Regression: the Bin used to offer add-to-shoot, which always failed with
  // "photos not found" because deleted rows are excluded from that lookup.
  await selectPhoto(page);
  await expect(page.getByRole('button', { name: 'Add to shoot' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Restore to original location' }).click();
  await expect(page.locator('.tile')).toHaveCount(0);

  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('the detail view shows shooting metadata, the triage control and steps between photos', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);

  // Three-way triage in the header, not a checkbox: "undecided" has to be
  // expressible, and the control is there even with the metadata column closed
  // (the default).
  const triage = page.locator('.detail__nav [aria-label="Triage"]');
  await expect(triage.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Undecided' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Pick' })).toBeVisible();

  await showMetadata(page);

  // Located by title rather than by any text the panel holds: row values name the
  // camera too, which matches more than one panel.
  const panel = (title: string) => page.locator('.panel', { has: page.locator('.panel__title', { hasText: title }) });

  // The fixture is portrait, so the panels sit in the full-height column beside
  // it and open on every row. ISO/shutter/aperture are read from the RAW header.
  const camera = panel('CAMERA');
  await expect(camera.getByText('Body', { exact: true })).toBeVisible();
  await expect(camera.getByText('Lens', { exact: true })).toBeVisible();
  await expect(camera.getByText('ISO', { exact: true })).toBeVisible();
  await expect(camera.getByText('Shutter', { exact: true })).toBeVisible();
  await expect(camera.getByText('Aperture', { exact: true })).toBeVisible();

  // Collapsing leaves the same two leading rows every panel keeps.
  await camera.getByRole('button', { name: /less/ }).click();
  await expect(camera.locator('.meta dt')).toHaveCount(2);

  await page.getByRole('button', { name: 'Hide metadata' }).click();
  await expect(camera).toHaveCount(0);
  await expect(triage.getByRole('button', { name: 'Pick' })).toBeVisible();
  await page.getByRole('button', { name: 'Show metadata' }).click();

  // The served rendition reports where its pixels came from and how it was encoded.
  // This library serves the camera's JPEG, which is passed through untouched, so
  // the encoder settings the built renditions carry do not describe it.
  const renditionPanel = panel('RENDITION DETAILS');
  await expect(renditionPanel.getByText('Showing', { exact: true })).toBeVisible();
  await expect(renditionPanel.getByText('JPEG', { exact: true })).toBeVisible();
  await expect(renditionPanel.getByText('N/A')).toBeVisible();

  // Both panels name the file on the server they are describing. This library
  // serves the camera's JPEG, so the photo opens at the RAW's own bytes rather
  // than at a stored rendition - which is what makes them the same path here.
  const raw = panel('ORIGINAL RAW');
  const navPath = page.locator('.detail__nav .detail__path');
  const relative = await navPath.innerText();
  await expect(raw.getByText(path.join(CULL_PHOTOS_DIR, relative))).toBeVisible();

  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(navPath).not.toHaveText(relative);
});

// The warm is only worth anything if the reader lands on the URL it was warmed
// at. A rebuild announced while a neighbour is being warmed moves that URL, and
// the frame the reader steps onto has to move with it - held per view, the two
// disagreed, and the plain URL the viewer fell back to is answered out of the
// copy the browser already has: the file from before the rebuild.
test('a neighbour rebuilt while it was warmed is painted at the URL it was warmed at', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  const second = await page.locator('.tile img').nth(1).getAttribute('src');
  const secondId = /\/image\/([^/]+)\//.exec(second ?? '')?.[1] ?? '';
  expect(secondId).not.toBe('');

  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const warmed = page.locator(`.stage__viewport img[aria-hidden="true"][src*="${secondId}"]`);
  await expect(warmed).toHaveCount(1);

  // Rebuilt from under the reader while they are still on its neighbour.
  await page.request.post(`${API_URL}/api/photos/${secondId}/renditions/full?force=true`);
  await expect(warmed).toHaveAttribute('src', /\?v=/, { timeout: 60_000 });
  const warmedSrc = await warmed.getAttribute('src');

  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(page.locator(`.stage__viewport img.is-ready[src*="${secondId}"]`)).toHaveAttribute('src', warmedSrc ?? '', {
    timeout: 60_000,
  });
});

test('a photo the catalogue does not have says so, with the reason', async ({ page }) => {
  await page.goto('/photos/11111111-1111-4111-8111-111111111111');

  // The other side of the state the viewer spent so long getting wrong: this is
  // the only thing that may render "not found", and it carries the read's own
  // error rather than whatever a list fetch last left behind.
  await expect(page.locator('.empty__title')).toHaveText('Photo not found');
  await expect(page.getByText(/photo not found: 11111111/)).toBeVisible();
});

// Two detail fetches can be in flight at once - stepping is faster than the
// round trip - and they need not answer in order.
test('a detail that lands after the reader has stepped on does not replace the photo they are looking at', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  const first = await page.locator('.tile img').first().getAttribute('src');
  const firstId = /\/image\/([^/]+)\//.exec(first ?? '')?.[1] ?? '';
  expect(firstId).not.toBe('');
  await page.route(`**/api/photos/${firstId}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });

  // Stepping off before the first photo's detail has landed. The buttons have to
  // be live for that: their neighbours come from the photo the route asks for,
  // not from the detail that has not arrived, or the first frame of every photo
  // opened from the grid is a dead end.
  await openPhoto(page);
  await page.getByRole('button', { name: 'Next photo' }).click();
  const navPath = page.locator('.detail__nav .detail__path');
  await expect(navPath).not.toHaveText('', { timeout: 30_000 });
  const stepped = await navPath.innerText();

  // The straggler names a photo the reader has already left. Written anyway, it
  // puts the previous photo's detail back in a store the page reads by id, so the
  // page reports the photo in the URL as one the catalogue does not have.
  await page.waitForTimeout(4000);
  await expect(page.getByText('Photo not found')).toHaveCount(0);
  await expect(navPath).toHaveText(stepped);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test("a selection's grid tiles can be rebuilt from the bulk bar", async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await selectPhoto(page);
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText(/Rebuilt 1 thumbnail/)).toBeVisible();

  // What the viewer is served is recorded per photo and a tile rebuild says
  // nothing about it, so the detail view reads the same afterwards.
  await openPhoto(page);
  await showMetadata(page);
  const renditionPanel = page.locator('.panel', { hasText: 'RENDITION DETAILS' });
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 30_000 });
});

test('a rebuilt rendition is pushed to the tile that changed, and to no other', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  const src = (index: number): Promise<string | null> => page.locator('.tile img').nth(index).getAttribute('src');
  const [rebuilt, untouched] = [await src(0), await src(1)];

  await selectPhoto(page);
  await bulkAction(page, 'Rebuild thumbnails');

  // The server names the photo it just wrote and the tile asks again for that one
  // alone. Nothing here polls, and no version lands on a photo that did not move.
  await expect.poll(() => src(0), { timeout: 60_000 }).not.toBe(rebuilt);
  expect(await src(1)).toBe(untouched);
});

// The two halves of an import are tracked apart all the way to the browser's
// cache: one stamp each, so a URL only moves when the file behind it did.
test('rebuilding a photo rendition leaves its grid tile where it is', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  const tile = page.locator('.tile img').first();
  const before = await tile.getAttribute('src');
  const photoId = /\/image\/([^/]+)\//.exec(before ?? '')?.[1] ?? '';
  expect(photoId).not.toBe('');

  // A render of the viewer's copy, which writes no tile. Shared one stamp, this
  // moved every tile URL on the page and re-downloaded bytes that had not changed.
  await page.request.post(`${API_URL}/api/photos/${photoId}/renditions/full?force=true`, { timeout: 180_000 });
  // Long enough for the announcement to have arrived and been applied.
  await expect.poll(async () => (await page.locator('.tile img').nth(1).getAttribute('src')) ?? '').not.toBe('');
  await page.waitForTimeout(1000);
  expect(await tile.getAttribute('src')).toBe(before);

  // And the viewer's own URL did move, so the announcement was heard - it is the
  // stage that changed, not the fact of a change, that the tile ignored.
  await openPhoto(page);
  await expect(page.locator(`.stage__viewport img.is-ready[src*="/renditions/full?v="]`)).toBeVisible({ timeout: 60_000 });
});

// A photo can be marked processed while its renditions are gone: a failed build,
// a half-finished copy, a pruned data directory. Nothing would ever queue it
// again, so the detail view has to notice and build the one it needs rather than
// sit on "no rendition yet".
//
// Rebuilding must be the *missing* rendition and not simply a reprocess: that
// writes the grid tile, which is not what the viewer asked for, so a library
// that renders would ask again on every paint and never settle.
test('opening a photo whose rendition is gone builds that rendition back', async ({ page }) => {
  // Two real renders of the RAW, and the 60s default expires mid-poll: the
  // failure then reads as a timeout rather than as the wait it is.
  test.setTimeout(240_000);
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const photoId = openPhotoId(page);

  // A library that serves the camera's JPEG cannot lose its rendition - those bytes
  // come out of a RAW that is still on disk - so the gap only exists for one that
  // renders. Switching it is also what makes the reload open at the full-size
  // rendition rather than at the JPEG.
  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  const full = path.join(CULL_PHOTOS_DIR, '.bowerbird', 'renditions', 'full', `${photoId}.avif`);

  await page.goto(`/photos/${photoId}`);
  await expect.poll(() => existsSync(full), { timeout: 90_000 }).toBe(true);
  rmSync(full, { force: true });

  await page.reload();
  await expect.poll(() => existsSync(full), { timeout: 90_000 }).toBe(true);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
});

// The point of caching the renditions is that switching back to one already seen
// costs nothing.
test('a chosen rendition is cached on disk, and survives a tile rebuild', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const photoId = openPhotoId(page);

  const showRendition = async (label: string): Promise<void> => {
    await page.getByRole('button', { name: 'Rendition' }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };

  const renditionPanel = page.locator('.panel', { hasText: 'RENDITION DETAILS' });
  await showMetadata(page);
  await showRendition('Rendered RAW');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.stage__busy')).toBeHidden();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // The photo's own renditions are the embedded rendition, so only the render had
  // to be built and stored; the embedded one is served from what already existed.
  const cached = path.join(CULL_PHOTOS_DIR, '.bowerbird', 'renditions', 'full', `${photoId}.avif`);
  expect(existsSync(cached)).toBe(true);

  // Every rendition stays on offer whichever one is showing, the camera's JPEG
  // included: comparing a render against it is a reason to step back down.
  //
  // And stepping between two that are already there costs nothing. Counted rather than
  // timed, because what went wrong was a request rather than a delay: every choice asked
  // the server to build - the camera's JPEG, which is never built at all, included - and
  // waited on a detail fetch before it would swap. So the render flashed "Rendering" over
  // itself, the JPEG took a round trip to appear, and both views were in the DOM the whole
  // time.
  const asked: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/photos\//.test(request.url())) asked.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await showRendition('Embedded JPEG');
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.stage__busy')).toBeHidden();
  await showRendition('Rendered RAW');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.stage__busy')).toBeHidden();
  // Nothing at all: not the build, and not the detail fetch that used to be awaited before
  // the swap was allowed to happen even when there was no build to learn anything about.
  expect(asked, 'a swap between two renditions already built asks the server for nothing').toEqual([]);

  // The grid's rebuild is the grid tile and nothing else. It used to queue both
  // stages, which had the run sweep every rendition it did not itself write - so
  // regenerating a rendition deleted the render the viewer was holding, and the
  // next look paid for it again.
  await openLibrary(page, CULL_PHOTOS_DIR);
  await selectPhoto(page);
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText(/Rebuilt 1 thumbnail/)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000); // the sweep that must not happen is fire-and-forget
  expect(existsSync(cached)).toBe(true);
});

// Switching between the camera's JPEG and a render is the comparison the detail
// view exists for, so it is a keystroke rather than a trip through the menu.
test('i and o switch between the camera JPEG and the render, and the cache can be forced past', async ({ page }) => {
  // A forced rebuild is a real render of the RAW, not a cache hit.
  test.setTimeout(240_000);
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const photoId = openPhotoId(page);

  const renditionPanel = page.locator('.panel', { hasText: 'RENDITION DETAILS' });
  await showMetadata(page);
  await page.keyboard.press('o');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('i');
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });

  // The file is the cache, so nothing rebuilds a rendition once it exists. This
  // is the escape hatch for working on the pipeline: the same choice, but the
  // stored copy is dropped first.
  const cached = path.join(CULL_PHOTOS_DIR, '.bowerbird', 'renditions', 'full', `${photoId}.avif`);
  const before = statSync(cached).mtimeMs;
  await page.getByRole('button', { name: 'Rendition' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Disable cache when changing rendition' }).click();
  // The toggle leaves the menu open on purpose - it says what the actions above
  // it will do. Close it, then put focus back on the page: an open menu makes
  // everything behind it inert, and its trigger eats letter keys as typeahead.
  await page.getByRole('button', { name: 'Rendition' }).click();
  await page.locator('.detail__nav .detail__path').click();
  await page.keyboard.press('o');
  // A build made on request is covered over the photograph while it runs, so the frame
  // underneath is not mistaken for the one that was asked for. Asserted here rather than on
  // a plain choice, which is a swap between files that already exist and covers nothing.
  await expect(page.locator('.stage__busy')).toContainText('Rendering');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.stage__busy')).toBeHidden();
  await expect.poll(() => statSync(cached).mtimeMs, { timeout: 120_000 }).toBeGreaterThan(before);

  // Rewriting the file is only half of it: the URL is stable, so the stage would
  // go on showing the copy it has already decoded. Nothing announces a build made
  // outside the processing queue, so the client that asked for it says so itself,
  // and the version lands on this photo alone.
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveAttribute('src', /\/renditions\/full\?v=/, { timeout: 60_000 });
});

// The max-quality rendition goes straight to an <img>: AVIF decodes natively in
// every browser, which is why it replaced the JXL that needed a wasm module and
// a PNG transcode first (§10.5).
test('the max-quality rendition is served as a full-resolution AVIF', async ({ page }) => {
  test.setTimeout(240_000);
  await viewMaxQuality(page, CULL_PHOTOS_DIR);

  const shown = page.locator('.stage__viewport img.is-ready');
  expect(await shown.evaluate((i: HTMLImageElement) => i.src)).toContain('/renditions/max');
  // Full resolution, not the 3840-edge rendition it replaced.
  expect(await shown.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(3840);
});

// Regression: the run of photographs the arrows walk is emptied whenever the
// collection is re-read, but the anchor it is asked for is the open photo's id -
// so re-opening the *same* photo left the anchor unchanged, the reaction never
// fired, and both arrows stayed dead for as long as that photo was open. Every
// photo of a small collection is within the margin, so it was not an edge case.
test('the arrows come back after leaving a photo and opening it again', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.getByRole('button', { name: 'Next photo' })).toBeEnabled({ timeout: 60_000 });

  for (let round = 0; round < 2; round++) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.grid')).toBeVisible();
    await openPhoto(page);
    await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Next photo' }), `after ${round + 1} trips`).toBeEnabled({ timeout: 30_000 });
  }
});

// A frame that arrives around the moment the held one is dropped still goes up.
//
// Every other check here has the image arrive instantly, so nothing covered a
// decode landing near the cap at all. It does NOT reproduce the commit-order race
// the guard in `setPainted` is for - that needs the promotion to commit between
// the timer firing and the effect that would have cancelled it, which an idle
// machine almost never does. Treat this as coverage of slow decodes, not of that.
test('a frame that lands as the held one is dropped is still shown', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // Delays either side of the 100ms cap.
  for (const delay of [80, 105, 130]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route(/\/image\//, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(page.locator('.stage__viewport img.is-ready'), `delay ${delay}ms`).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Previous photo' }).click();
    await expect(page.locator('.stage__viewport img.is-ready'), `delay ${delay}ms, back`).toBeVisible({ timeout: 20_000 });
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('the previous photo is held for a beat and then dropped, however slow the next one is', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();
  const openId = openPhotoId(page);

  // Held open, so the hold is observable at all: warmed, the next frame decodes
  // faster than this can sample.
  await page.route(/\/image\//, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });

  // Sampled every frame rather than read once after the click: the hold is capped
  // in the tens of milliseconds, which no round trip can be relied on to land in.
  await page.evaluate(() => {
    const samples: { id: string; src: string }[] = [];
    (window as unknown as { stageSamples: typeof samples }).stageSamples = samples;
    const tick = (): void => {
      const img = document.querySelector<HTMLImageElement>('.stage__viewport img.is-ready');
      samples.push({ id: location.pathname.split('/').pop() ?? '', src: img?.src ?? '' });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.getByRole('button', { name: 'Next photo' }).click();
  await page.waitForTimeout(1000);
  const after = (await page.evaluate(() => (window as unknown as { stageSamples: { id: string; src: string }[] }).stageSamples)).filter(
    (s) => s.id !== openId,
  );

  // The frame before stays up across the route change: dropping it first turns
  // the decode of even a warmed neighbour into a blink of stage background.
  expect(after.some((s) => s.src.includes(openId))).toBe(true);
  // And only for a beat. The panels beside it already describe the photo in the
  // URL, so a held frame that outlasts its cap is the wrong picture rather than a
  // smooth step - and this one's own image is still three seconds out.
  expect(after.at(-1)?.src).toBe('');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
});

// Regression: the panels were gated on this photo's detail arriving, so the strip
// under a landscape frame collapsed to nothing while it was in flight and the
// stage - a grid track sized against that strip - painted the photo full-size and
// then shrank it when the panels landed.
test('the panels keep their shape while the next photo is loading', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  await showMetadata(page);

  // Held open, or the API answers before there is a loading state to observe.
  await page.route(/\/api\/photos\/[^/?]+$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });

  // Every panel is up while the fetch is still out, holding its rows empty rather
  // than by keeping the previous photo's values.
  await page.getByRole('button', { name: 'Next photo' }).click();
  const camera = page.locator('.panel', { has: page.locator('.panel__title', { hasText: 'CAMERA' }) });
  await expect(camera.getByText('loading').first()).toBeVisible();
  // Notes, Camera, Rendition, Original RAW - triage/rating live in the header now.
  await expect(page.locator('.detail__panels .panel')).toHaveCount(4);
});

test('the next photo is fetched while the current one is on screen', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    const match = /\/image\/([^/]+)\/renditions\/full/.exec(r.url());
    if (match?.[1] != null) fetched.push(match[1]);
  });

  // Only a stored rendition is warmed. A library serving the camera's JPEG has
  // nothing to preload, so say which kind this is rather than inheriting it from
  // whichever test ran last.
  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  // And which rendition it opens at, for the same reason: "last used" is global
  // and a test above leaves the max-quality one behind, which is chosen rather
  // than the library's default and so deliberately never warmed.
  await setViewerRendition(page, 'Rendered RAW');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  // The neighbour is warmed only after this frame decodes, so it never competes
  // for the connection with the one being waited on.
  const openId = openPhotoId(page);
  await expect.poll(() => fetched.some((id) => id !== openId)).toBe(true);
});

// Regression: which rendition the viewer shows came from the photo's detail, so
// a reader set to the camera's JPEG in a library that renders got the render
// first - fetched, decoded and painted with its lens distortion still in - and
// then swapped out the moment the setting could be applied. Every step through
// the cull paid for both files.
test('a reader set to the camera JPEG never loads the render', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));

  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Embedded JPEG');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // Warmed at the rendition on screen rather than the library's, or the step
  // below arrives cold and shows the stage background while it fetches.
  const openId = openPhotoId(page);
  await expect.poll(() => requested.some((url) => url.includes('/embedded.jpg') && !url.includes(openId))).toBe(true);

  requested.length = 0;
  await page.getByRole('button', { name: 'Next photo' }).click();
  const nextId = openPhotoId(page);
  await expect(page.locator(`.stage__viewport img.is-ready[src*="${nextId}"]`)).toBeVisible({ timeout: 60_000 });
  expect(requested.filter((url) => url.includes(`/${nextId}/renditions/`))).toEqual([]);
});

// "Last used per photo" is the same question as the setting above, asked per
// photo rather than once: the answer has to be on the row for the same reason,
// or reopening a photo paints the library's default while the detail carrying
// the reader's own choice is still in flight.
test('a photo reopens at the rendition it was last read in, without the library default first', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));

  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Last used per photo');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  const photoId = openPhotoId(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // Read it in the camera's JPEG, which this library does not default to.
  await page.keyboard.press('i');
  await showMetadata(page);
  const renditionPanel = page.locator('.panel', { hasText: 'RENDITION DETAILS' });
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press('Escape');
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  requested.length = 0;
  await openPhoto(page);

  await expect(page.locator(`.stage__viewport img.is-ready[src*="/embedded.jpg"]`)).toBeVisible({ timeout: 60_000 });
  expect(requested.filter((url) => url.includes(`/${photoId}/renditions/`))).toEqual([]);
});

interface Sample {
  id: string;
  src: string;
}

// The two flashes this work started from, measured the way they were reported:
// every animation frame across a step, in the configuration they were seen in -
// a library that renders the RAW, read at the camera's JPEG.
//
// Both were about *which* file the viewer asked for and *when*, so both show up
// here as facts about the frames on screen: a step must never leave the stage
// empty, and the render must never be the picture, not even for a frame.
test('stepping through photos shows no empty stage and never the wrong rendition', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Embedded JPEG');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  // The neighbour is warmed once this frame is up, and the step below is only
  // honest with the warm in place - it is half of why there is no gap.
  await page.waitForTimeout(1500);

  const sample = async (): Promise<void> => {
    await page.evaluate(() => {
      const samples: Sample[] = [];
      (window as unknown as { flash: Sample[] }).flash = samples;
      const tick = (): void => {
        const shown = document.querySelector<HTMLElement>('.stage__viewport .is-ready');
        samples.push({ id: location.pathname.split('/').pop() ?? '', src: shown?.getAttribute('src') ?? '' });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };

  // Only the frames after the route has moved on: the ones before it are the
  // photo being left, which is nobody's idea of a flash.
  const after = async (from: string): Promise<Sample[]> => {
    const samples = await page.evaluate(() => (window as unknown as { flash: Sample[] }).flash);
    return samples.filter((s) => s.id !== from);
  };

  const step = async (button: string): Promise<Sample[]> => {
    const from = openPhotoId(page);
    await sample();
    await page.getByRole('button', { name: button }).click();
    await page.waitForTimeout(2000);
    const frames = await after(from);
    expect(frames.length).toBeGreaterThan(30);
    return frames;
  };

  for (const button of ['Next photo', 'Previous photo']) {
    const frames = await step(button);
    // A blank frame is the stage's own background, which is what the reader
    // reported seeing between photos. The previous frame is held until the next
    // one has decoded, so there should be nothing to see: a couple of frames of
    // slack for a cold machine, not the hundreds of milliseconds a fetch takes.
    expect(frames.filter((f) => f.src === '').length, `blank frames after ${button}`).toBeLessThanOrEqual(3);
    // And never the library's default. Painting the render first and swapping it
    // out is the second flash, and it is invisible to a request-level assertion
    // once the file is cached.
    expect(frames.filter((f) => f.src.includes('/renditions/')), `render frames after ${button}`).toEqual([]);
  }
});

test('the photo fits the stage instead of overflowing it', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  // Regression: as a grid item the image grew the row to its own height, so
  // `height: 100%` resolved against that and tall frames were cropped.
  const fits = await page.locator('.stage__viewport').evaluate((vp) => {
    const img = vp.querySelector('img');
    if (img == null) return false;
    return img.getBoundingClientRect().height <= vp.clientHeight + 1;
  });
  expect(fits).toBe(true);
});

test('clicking zooms into the point clicked, not the centre', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  // Regression: the zoom-about-point maths ran inside a setScale updater and
  // called setOffset from within it. React re-invokes updaters, so the offset was
  // applied about twice and the clicked detail slid away from the cursor.
  const drift = await page.locator('.stage__viewport').evaluate(async (vp) => {
    const img = vp.querySelector('img');
    if (img == null) return null;
    const box = vp.getBoundingClientRect();
    const fit = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const read = (): { x: number; y: number; s: number } => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(img.style.transform);
      return m == null ? { x: 0, y: 0, s: 1 } : { x: +m[1]!, y: +m[2]!, s: +m[3]! };
    };
    // Which point of the photo sits under a screen coordinate, 0..1.
    const fraction = (px: number, py: number): { x: number; y: number } => {
      const t = read();
      const w = img.naturalWidth * fit * t.s;
      const h = img.naturalHeight * fit * t.s;
      return {
        x: (px - (box.left + box.width / 2 + t.x - w / 2)) / w,
        y: (py - (box.top + box.height / 2 + t.y - h / 2)) / h,
      };
    };
    // Off-centre but well inside the pan limits, so the clamp cannot mask this.
    const px = box.left + box.width * 0.5;
    const py = box.top + box.height * 0.62;
    const before = fraction(px, py);
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py }));
    await new Promise((r) => setTimeout(r, 200));
    const after = fraction(px, py);
    return { zoomed: read().s > 1, dx: Math.abs(after.x - before.x), dy: Math.abs(after.y - before.y) };
  });

  expect(drift?.zoomed).toBe(true);
  expect(drift?.dx).toBeLessThan(0.01);
  expect(drift?.dy).toBeLessThan(0.01);
});

test('panning a zoomed photo cannot drag it off the stage', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  const viewport = page.locator('.stage__viewport');
  const box = (await viewport.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Drag far past any legal offset. Unclamped this left the photo detached from
  // the viewport edge, showing empty background where the image should be.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 4000, cy + 4000, { steps: 5 });
  await page.mouse.up();

  const gap = await viewport.evaluate((vp) => {
    const img = vp.querySelector('img');
    if (img == null) return -1;
    const i = img.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    // How far the image's leading edges sit inside the viewport. A zoomed photo
    // is larger than the stage, so this can never legitimately be positive.
    return Math.max(i.left - v.left, i.top - v.top);
  });
  expect(gap).toBeLessThanOrEqual(1);
  // And it moved at all: the clamp above is satisfied just as well by a drag
  // that did nothing, which is what the regression below actually was.
  const moved = await page.locator('.stage__viewport img.is-ready').evaluate((img) => img.style.transform);
  expect(moved).not.toContain('translate(0px, 0px)');
});

// Regression: the warmed neighbours are full-size images stacked over the frame,
// so the pointer landed on one of them. Chromium honours the -webkit-user-drag
// they inherit; Firefox does not, and started an image drag that cancelled the
// pointer capture, so a zoomed photo could not be panned at all.
test('the warmed neighbours never take the pointer from the frame', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  // The warm only starts once this frame is up, so there is nothing to stack
  // over it until then.
  await expect(page.locator('.stage__viewport img[aria-hidden="true"]')).not.toHaveCount(0, { timeout: 60_000 });

  const hit = await page.locator('.stage__viewport').evaluate((vp) => {
    const box = vp.getBoundingClientRect();
    const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return el?.getAttribute('aria-hidden');
  });
  expect(hit).toBeNull();
});

// Regression: a fully transparent element is never rasterised, so the frame
// revealed on promotion had no raster and the browser needed a frame or two to
// build one. Dropped in the same commit, the outgoing frame left the stage
// background showing through for exactly that long, on every swap. Sampling
// which src carries `is-ready` cannot see it: the DOM is already correct, so
// what this pins is the overlap that covers the gap.
test('the frame being replaced is held opaque under its replacement for a beat', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // Every frame, because the hold is a few frames long and no round trip can be
  // relied on to land inside it.
  await page.evaluate(() => {
    const counts: number[] = [];
    (window as unknown as { opaque: number[] }).opaque = counts;
    const tick = (): void => {
      counts.push(document.querySelectorAll('.stage__viewport .is-ready, .stage__viewport .is-retiring').length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.keyboard.press('o');
  await showMetadata(page);
  await expect(page.locator('.panel', { hasText: 'RENDITION DETAILS' }).getByText('Rendered RAW')).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1000);

  const counts = await page.evaluate(() => (window as unknown as { opaque: number[] }).opaque);
  // Two frames up at once across the swap, and back to one after it: a hold that
  // never ends would leave the photo before this one on the stage.
  expect(counts.filter((n) => n === 2).length).toBeGreaterThan(0);
  expect(counts.at(-1)).toBe(1);
});

// The direction is read off the run - the ordering the arrows themselves step
// through - rather than off the control that moved it, so the arrows, the
// buttons and the browser's own back all animate the way the reader went.
test('stepping to a neighbour slides in from the side it came from', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  // Opening a photo is not a step, so the first frame just appears.
  await expect(page.locator('.stage__viewport img.is-ready.is-stepping-next')).toHaveCount(0);
  await expect(page.locator('.stage__viewport img.is-ready.is-stepping-prev')).toHaveCount(0);

  await page.keyboard.press('ArrowRight');
  const forwards = page.locator('.stage__viewport img.is-ready.is-stepping-next');
  await expect(forwards).toBeVisible({ timeout: 60_000 });
  // The class outlives the animation, so this is the stylesheet's half of it:
  // named the other way round, both steps would look identical.
  expect(await forwards.evaluate((img) => getComputedStyle(img).animationName)).toBe('stage-step-in-next');

  await page.keyboard.press('ArrowLeft');
  const backwards = page.locator('.stage__viewport img.is-ready.is-stepping-prev');
  await expect(backwards).toBeVisible({ timeout: 60_000 });
  expect(await backwards.evaluate((img) => getComputedStyle(img).animationName)).toBe('stage-step-in-prev');

  // A rendition swap holds the photo, so there is no direction to it and the new
  // file has to replace the old one where it is rather than sliding in.
  await page.keyboard.press('o');
  await showMetadata(page);
  await expect(page.locator('.panel', { hasText: 'RENDITION DETAILS' }).getByText('Rendered RAW')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.stage__viewport img.is-ready:not(.is-stepping-next):not(.is-stepping-prev)')).toBeVisible({
    timeout: 120_000,
  });

  // The frame carries an inline transform for zoom and pan, so the slide is a
  // `translate` of its own to compose with it rather than fight it. Held open,
  // because at its real length there is no non-flaky moment to measure it in.
  await page.addStyleTag({ content: '.stage__viewport .stage__content { animation-duration: 4s !important; }' });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.stage__viewport img.is-ready.is-stepping-next')).toBeVisible({ timeout: 60_000 });
  const viewport = await page.locator('.stage__viewport').boundingBox();
  const arriving = await page.locator('.stage__viewport img.is-ready.is-stepping-next').boundingBox();
  // Right of where it will settle, which is the viewport it is inset to: a next
  // step comes in from the side the reader is heading towards.
  expect(arriving?.x ?? 0).toBeGreaterThan(viewport?.x ?? 0);
});

// The stage's view state is keyed on the photo, never on the file being shown.
// Stack triage's flip mode is built entirely on this (§20.4): it holds two
// frames of one round under a single photoKey, so that alternating between them
// keeps the zoom and pan the photographer set up. These two pin the property from
// the viewer's side, where it is also what makes "compare this render against the
// camera's JPEG" a comparison rather than a reset.
test('zoom survives a rendition change, so two files can be compared at the same magnification', async ({ page }) => {
  await page.goto('/settings');
  await setRenditionSource(page, CULL_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Rendered RAW');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  const scale = (): Promise<number> =>
    page.locator('.stage__viewport img.is-ready').evaluate((img) => {
      const match = /scale\(([\d.]+)\)/.exec((img as HTMLElement).style.transform);
      return match == null ? 1 : Number(match[1]);
    });

  await page.getByRole('button', { name: 'Zoom in' }).click();
  expect(await scale()).toBeGreaterThan(1);
  const before = await scale();

  // A different file for the same photograph: photoKey does not move, so nothing
  // about the view should.
  await page.keyboard.press('i');
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveAttribute('src', /embedded\.jpg/, { timeout: 60_000 });
  expect(await scale()).toBe(before);
});

test('zoom resets on a step to the next photo, which is a different photograph', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(page.locator('.stage--zoomed')).toBeVisible();

  // Carrying the offset across would open the next frame scrolled into a corner.
  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(page.locator('.stage--zoomed')).toHaveCount(0);
});

test('the zoom control steps fit, double, then the frame at its own pixels', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // In the bar with the rest of the controls rather than over the corner of the
  // photograph, and against the frame's own pixels: a 24MP render fitted to a
  // stage a few hundred pixels tall is nowhere near 1:1.
  const readout = page.locator('.detail__nav .stage__scale');
  await expect(readout).not.toHaveText('100%');

  await page.getByRole('button', { name: 'Zoom in' }).click();
  // Regression: the ceiling was a flat multiple of the fitted size, so on a
  // render this large 1:1 sat above it and the control topped out around 86%.
  await page.getByRole('button', { name: 'Zoom to 100%' }).click();
  await expect(readout).toHaveText('100%');

  await page.getByRole('button', { name: 'Zoom out to fit' }).click();
  await expect(page.locator('.stage--zoomed')).toHaveCount(0);
});

/**
 * A zoomed photograph has to stay inside its stage when the stage changes shape.
 *
 * The pan limit is half of what the picture overhangs the viewport by, so widening the
 * stage on an axis the fit is not bound by shrinks the limit while the offset stays where
 * the reader left it. Only a change of *frame* used to re-clamp, so what was on screen was
 * a strip of stage background beside the picture, held until the next drag - which then
 * moved nothing until it had eaten the excess, and snapped.
 */
test('holds a zoomed photo inside a stage that changed shape', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await openPhoto(page);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // What the transform is, and what it is allowed to be, measured from the page rather than
  // assumed: the limit depends on the frame's shape and the box it is fitted into.
  const state = async (): Promise<{ x: number; limit: number }> => {
    return page.locator('.stage__viewport').evaluate((viewport: HTMLElement) => {
      const frame = viewport.querySelector('img.is-ready') as HTMLImageElement;
      const transform = new DOMMatrixReadOnly(getComputedStyle(frame).transform);
      const box = viewport.getBoundingClientRect();
      const fit = Math.min(box.width / frame.naturalWidth, box.height / frame.naturalHeight);
      const content = frame.naturalWidth * fit * transform.a;
      return { x: transform.e, limit: Math.max(0, (content - box.width) / 2) };
    });
  };

  // All the way to the frame's own pixels, not just the double stop: this photograph is
  // portrait in a landscape stage, so at 2x it still does not overhang horizontally and
  // there is no sideways pan to be left out of range.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom to 100%' }).click();
  await expect(page.locator('.stage--zoomed')).toBeVisible();

  // Panned hard against one edge, so the offset is exactly the limit and any shrinking of
  // that limit leaves it outside.
  const box = (await page.locator('.stage__viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 4000, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const panned = await state();
  expect(panned.limit).toBeGreaterThan(0);
  expect(panned.x).toBeCloseTo(panned.limit, 0);

  // Now give the stage more room across, which is what hiding the panels beside a portrait
  // photograph does. The frame has not changed, so nothing else would re-clamp.
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width + 500, height: viewport.height });

  await expect
    .poll(async () => {
      const after = await state();
      return after.x - after.limit;
    })
    .toBeLessThanOrEqual(1);
});

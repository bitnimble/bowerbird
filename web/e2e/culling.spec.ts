import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL, CULL_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, libraryRow, openLibrary, syncLibrary, viewMaxQuality } from './helpers';

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
  await expect(page.locator('.tile--focused')).toHaveCount(1);
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

// Picking a burst out of a shoot is a range, not forty clicks.
test('shift-click extends the selection from the anchor', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  const tiles = page.locator('.tile');
  // Anchored on the last tile and then cleared, so a range that reaches it is
  // the only way the count can come back: the anchor is where the range starts
  // from, not what happens to be selected.
  await tiles.last().getByRole('button', { name: 'Select photo' }).click();
  await tiles.last().getByRole('button', { name: 'Deselect photo' }).click();
  await expect(page.locator('.tile--selected')).toHaveCount(0);

  await tiles.first().locator('.tile__hit').click({ modifiers: ['Shift'] });
  await expect(page.locator('.tile--selected')).toHaveCount(PHOTO_NAMES.length);

  // And it does not open the photo on the way.
  expect(page.url()).not.toContain('/photos/');

  // The tick box is the visible handle for selecting, so a range has to be
  // buildable from there too rather than only from the frame.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await tiles.last().getByRole('button', { name: 'Select photo' }).click();
  await tiles.first().getByRole('button', { name: 'Select photo' }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.tile--selected')).toHaveCount(PHOTO_NAMES.length);

  // The cursor answers for the anchor when nothing has been toggled: arrow to a
  // photo, shift-click another, get everything between them. ArrowLeft rather
  // than Right because the cursor is wherever the clicks above left it, and
  // moving it is clamped at the first tile.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.keyboard.press('ArrowLeft');
  await expect(tiles.first()).toHaveClass(/tile--focused/);
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
  await expect(page.locator('.tile--focused')).toHaveCount(1);
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

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Move to Bin' }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  // Regression: the Bin used to hold thumbnail-less grey boxes because
  // soft-delete removed the WebPs, making it impossible to find anything.
  await expect(page.locator('.tile__pending')).toHaveCount(0);

  // Regression: the Bin used to offer add-to-shoot, which always failed with
  // "photos not found" because deleted rows are excluded from that lookup.
  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await expect(page.getByRole('button', { name: 'Add to shoot' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Restore to original location' }).click();
  await expect(page.locator('.tile')).toHaveCount(0);

  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('the detail view shows shooting metadata, the triage control and steps between photos', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();

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

  // Three-way triage, not a checkbox: "undecided" has to be expressible.
  const triage = page.locator('.ui-seg--stretch');
  await expect(triage.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Undecided' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Pick' })).toBeVisible();

  // The served preview reports where its pixels came from and how it was encoded.
  // This library serves the camera's JPEG, which is passed through untouched, so
  // the encoder settings the built renditions carry do not describe it.
  const preview = panel('IMAGE PREVIEW DETAILS');
  await expect(preview.getByText('Source', { exact: true })).toBeVisible();
  await expect(preview.getByText('JPEG', { exact: true })).toBeVisible();
  await expect(preview.getByText('N/A')).toBeVisible();

  // Both panels name the file on the server they are describing. This library
  // serves the camera's JPEG, so the photo opens at the RAW's own bytes rather
  // than at a stored rendition - which is what makes them the same path here.
  const raw = panel('ORIGINAL RAW');
  const navPath = page.locator('.detail__nav .ui-text--mono');
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

  await page.locator('.tile__hit').first().click();
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
  await page.locator('.tile__hit').first().click();
  await page.getByRole('button', { name: 'Next photo' }).click();
  const navPath = page.locator('.detail__nav .ui-text--mono');
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

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Regenerate thumbnails' }).click();
  await expect(page.getByText(/Rebuilt 1 thumbnail/)).toBeVisible();

  // What the viewer is served is recorded per photo and a tile rebuild says
  // nothing about it, so the detail view reads the same afterwards.
  await page.locator('.tile__hit').first().click();
  const preview = page.locator('.panel', { hasText: 'IMAGE PREVIEW DETAILS' });
  await expect(preview.getByText('embedded JPEG')).toBeVisible({ timeout: 30_000 });
});

test('a rebuilt thumbnail is pushed to the tile that changed, and to no other', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  const src = (index: number): Promise<string | null> => page.locator('.tile img').nth(index).getAttribute('src');
  const [rebuilt, untouched] = [await src(0), await src(1)];

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Regenerate thumbnails' }).click();

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
  await libraryRow(page, CULL_PHOTOS_DIR).getByRole('button', { name: 'Render the RAW' }).click();
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
  await page.locator('.tile__hit').first().click();
  await expect(page.locator(`.stage__viewport img.is-ready[src*="/renditions/full?v="]`)).toBeVisible({ timeout: 60_000 });
});

// A photo can be marked processed while its renditions are gone: a failed build,
// a half-finished copy, a pruned data directory. Nothing would ever queue it
// again, so the detail view has to notice and build the one it needs rather than
// sit on "no preview yet".
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
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const photoId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // A library that serves the camera's JPEG cannot lose its preview - those bytes
  // come out of a RAW that is still on disk - so the gap only exists for one that
  // renders. Switching it is also what makes the reload open at the full-size
  // rendition rather than at the JPEG.
  await page.goto('/settings');
  await libraryRow(page, CULL_PHOTOS_DIR).getByRole('button', { name: 'Render the RAW' }).click();
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
test('a chosen preview rendition is cached on disk, and survives a tile rebuild', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const photoId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // Keyboard, not pointer: the submenu opens on a real hover transition, and on
  // the second pass the mouse is already resting where the trigger appears, so no
  // pointer event fires and nothing opens.
  const showRendition = async (label: string): Promise<void> => {
    await page.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Image preview' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };

  const preview = page.locator('.panel', { hasText: 'IMAGE PREVIEW DETAILS' });
  await showRendition('From RAW');
  await expect(preview.getByText('RAW render')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // The photo's own thumbnails are the embedded rendition, so only the render had
  // to be built and stored; the embedded one is served from what already existed.
  const cached = path.join(CULL_PHOTOS_DIR, '.bowerbird', 'renditions', 'full', `${photoId}.avif`);
  expect(existsSync(cached)).toBe(true);

  // Every rendition stays on offer whichever one is showing, the camera's JPEG
  // included: comparing a render against it is a reason to step back down.
  await showRendition('Embedded JPEG');
  await expect(preview.getByText('embedded JPEG')).toBeVisible({ timeout: 60_000 });
  await showRendition('From RAW');
  await expect(preview.getByText('RAW render')).toBeVisible({ timeout: 60_000 });

  // The grid's rebuild is the grid tile and nothing else. It used to queue both
  // stages, which had the run sweep every rendition it did not itself write - so
  // regenerating a thumbnail deleted the render the viewer was holding, and the
  // next look paid for it again.
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Regenerate thumbnails' }).click();
  await expect(page.getByText(/Rebuilt 1 thumbnail/)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000); // the sweep that must not happen is fire-and-forget
  expect(existsSync(cached)).toBe(true);
});

// Switching between the camera's JPEG and a render is the comparison the detail
// view exists for, so it is a keystroke rather than three clicks into a submenu.
test('i and o switch between the camera JPEG and the render, and the cache can be forced past', async ({ page }) => {
  // A forced rebuild is a real render of the RAW, not a cache hit.
  test.setTimeout(240_000);
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const photoId = new URL(page.url()).pathname.split('/').pop() ?? '';

  const preview = page.locator('.panel', { hasText: 'IMAGE PREVIEW DETAILS' });
  await page.keyboard.press('o');
  await expect(preview.getByText('RAW render')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('i');
  await expect(preview.getByText('embedded JPEG')).toBeVisible({ timeout: 60_000 });

  // The file is the cache, so nothing rebuilds a rendition once it exists. This
  // is the escape hatch for working on the pipeline: the same choice, but the
  // stored copy is dropped first.
  const cached = path.join(CULL_PHOTOS_DIR, '.bowerbird', 'renditions', 'full', `${photoId}.avif`);
  const before = statSync(cached).mtimeMs;
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Disable cache when changing preview' }).click();
  // The toggle leaves the menu open on purpose - it says what the actions above
  // it will do. Close it, then put focus back on the page: an open menu makes
  // everything behind it inert, and its trigger eats letter keys as typeahead.
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.locator('.detail__nav .ui-text--mono').click();
  await page.keyboard.press('o');
  await expect(preview.getByText('RAW render')).toBeVisible({ timeout: 120_000 });
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
  // Full resolution, not the 3840-edge preview it replaced.
  expect(await shown.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(3840);
});

test('the previous photo is held for a beat and then dropped, however slow the next one is', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();
  const openId = page.url().split('/').pop() ?? '';

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
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

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
  await expect(page.locator('.detail__panels .panel')).toHaveCount(5);
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
  await libraryRow(page, CULL_PHOTOS_DIR).getByRole('button', { name: 'Render the RAW' }).click();
  // And which rendition it opens at, for the same reason: "last used" is global
  // and a test above leaves the max-quality one behind, which is chosen rather
  // than the library's default and so deliberately never warmed.
  await page.getByRole('group', { name: 'Open photos at' }).getByRole('button', { name: 'From RAW', exact: true }).click();
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  // The neighbour is warmed only after this frame decodes, so it never competes
  // for the connection with the one being waited on.
  const openId = page.url().split('/').pop() ?? '';
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
  await libraryRow(page, CULL_PHOTOS_DIR).getByRole('button', { name: 'Render the RAW' }).click();
  await page.getByRole('group', { name: 'Open photos at' }).getByRole('button', { name: 'Camera JPEG', exact: true }).click();
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // Warmed at the rendition on screen rather than the library's, or the step
  // below arrives cold and shows the stage background while it fetches.
  const openId = page.url().split('/').pop() ?? '';
  await expect.poll(() => requested.some((url) => url.includes('/embedded.jpg') && !url.includes(openId))).toBe(true);

  requested.length = 0;
  await page.getByRole('button', { name: 'Next photo' }).click();
  const nextId = page.url().split('/').pop() ?? '';
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
  await libraryRow(page, CULL_PHOTOS_DIR).getByRole('button', { name: 'Render the RAW' }).click();
  await page.getByRole('group', { name: 'Open photos at' }).getByRole('button', { name: 'Last used per photo' }).click();
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  const photoId = page.url().split('/').pop() ?? '';
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  // Read it in the camera's JPEG, which this library does not default to.
  await page.keyboard.press('i');
  const preview = page.locator('.panel', { hasText: 'IMAGE PREVIEW DETAILS' });
  await expect(preview.getByText('embedded JPEG')).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press('Escape');
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  requested.length = 0;
  await page.locator('.tile__hit').first().click();

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
  await libraryRow(page, CULL_PHOTOS_DIR).getByRole('button', { name: 'Render the RAW' }).click();
  await page.getByRole('group', { name: 'Open photos at' }).getByRole('button', { name: 'Camera JPEG', exact: true }).click();
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  await page.locator('.tile__hit').first().click();
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
    const from = page.url().split('/').pop() ?? '';
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
  await page.locator('.tile__hit').first().click();
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
  await page.locator('.tile__hit').first().click();
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
  await page.locator('.tile__hit').first().click();
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
});

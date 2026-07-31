import { expect, test, type Page } from '@playwright/test';
import { API_URL, STACK_PHOTO_NAMES, STACK_PHOTOS_DIR } from './fixture_library';
import { addLibrary, bulkAction, openLibrary, openPhotoId, syncLibrary, waitForSyncSettled } from './helpers';

/** The one stack in this spec's library, found through the collapsed listing. */
async function stackIdOfLibrary(page: Page): Promise<string> {
  const libraries = (await (await page.request.get(`${API_URL}/api/libraries`)).json()) as { id: string; root_path: string }[];
  const library = libraries.find((entry) => entry.root_path === STACK_PHOTOS_DIR);
  const rows = (await (await page.request.get(`${API_URL}/api/libraries/${library?.id}/photos?limit=50`)).json()) as {
    photos: { stack_id: string | null }[];
  };
  return rows.photos.find((photo) => photo.stack_id != null)?.stack_id ?? '';
}

// Stacks, driven through the real grid (DESIGN §19).
//
// The fixture is one ARW copied under two names, so the frames are identical and
// detection groups them - which is the right answer for a library of duplicates,
// and what lets this spec exercise the real detection path without shipping a
// second RAW. The other specs switch stacking off for exactly the same reason.
//
// Serial because each test leaves the library in the state the next one starts
// from, and they share one catalogue.
test.describe.configure({ mode: 'serial' });

test('identical frames collapse into one tile that says how many it stands for', async ({ page }) => {
  // The one library that keeps stacking on: its frames are the ones meant to be
  // found alike.
  await addLibrary(page, STACK_PHOTOS_DIR, { autoStack: true });
  await syncLibrary(page, STACK_PHOTOS_DIR);
  // Detection runs as part of settling, so the grid has to be opened after it
  // rather than during the import.
  await waitForSyncSettled(page, STACK_PHOTOS_DIR, STACK_PHOTO_NAMES.length);
  await openLibrary(page, STACK_PHOTOS_DIR);

  await expect(page.locator('.tile')).toHaveCount(1, { timeout: 45_000 });
  await expect(page.locator('.tile__stack-count')).toHaveText(String(STACK_PHOTO_NAMES.length));
});

test('the tile opens a band of members below the row, and closes it again', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  const tile = page.locator('.tile:not(.tile--member) .tile__hit');

  await tile.click();
  await expect(page.locator('.grid__band')).toHaveCount(1);
  await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);
  // The stack's own tile stays where it is, now marked as what closes the band.
  await expect(page.locator('.tile__stack--open')).toHaveCount(1);

  await tile.click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

test('every view opens the band, and none of them draws it over the grid', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  const tile = page.locator('.tile:not(.tile--member) .tile__hit');
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });

  for (const view of ['Masonry', 'List', 'Grid']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    // Masonry packs from each photo's shape rather than on a row model, and used
    // to offer no way into a stack at all.
    await expect(page.locator('.tile__stack')).toBeVisible();

    await tile.click();
    const band = page.locator('.grid__band');
    await expect(band).toHaveCount(1);
    await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);
    // Joined to the tile that opened it in every view, masonry included - where the
    // tile's place on its line has to be measured before the edge can be cut.
    await expect(page.locator('.grid__band--fused')).toHaveCount(1);

    // The members sit inside the outline rather than on it: the band pays for
    // that padding out of its own cells, so its last row cannot hang through the
    // bottom of it.
    const box = (await band.boundingBox())!;
    const last = (await page.locator('.grid__band .tile').last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(box.y + box.height);
    expect(last.y).toBeGreaterThanOrEqual(box.y);

    await tile.click();
    await expect(page.locator('.grid__band')).toHaveCount(0);
  }
});

test('a masonry band leaves the line it broke at the size it was', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'Masonry', exact: true }).click();

  const tile = page.locator('.tile:not(.tile--member)');
  const before = (await tile.boundingBox())!;
  await tile.locator('.tile__hit').click();
  await expect(page.locator('.grid__band')).toHaveCount(1);

  // The band is a full-width item and goes after the line its tile sits on, so
  // nothing on that line changes size: a band that broke the line where the tile
  // was handed it the width the band took, stretching the stack across the grid.
  expect((await tile.boundingBox())!.width).toBeCloseTo(before.width, 0);

  await tile.locator('.tile__hit').click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

test('a list row opens its stack from anywhere along it, not just the thumbnail', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: 'List', exact: true }).click();

  // Clicked past the thumbnail, which is most of a list row and used to be dead
  // space: through the mouse rather than the locator, because the point of this
  // is which element the click lands on and Playwright would refuse to click one
  // that hands its clicks to the row.
  const row = (await page.locator('.tile:not(.tile--member)').first().boundingBox())!;
  await page.mouse.click(row.x + row.width - 40, row.y + row.height / 2);
  await expect(page.locator('.grid__band')).toHaveCount(1);
  // A member row says as much about itself as any other row does.
  await expect(page.locator('.grid__band .tile').first().getByText(/\d{4}/)).toBeVisible();

  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
});

// One selection, whether a photo was chosen in the grid or inside an open stack:
// a member has no position to be in a run, so it travels by id beside them
// (§19.6.1).
test('a selection spans the grid and the contents of a stack', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  const stack = page.locator('.tile:not(.tile--member) .tile__hit');
  await stack.click();
  await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);
  // Opening it selected nothing: a stack's tile is a disclosure (§19.6). Cmd-click
  // is what selects the row, and it leaves the band open.
  await expect(page.locator('.tile--selected')).toHaveCount(0);
  await stack.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);

  // Cmd-clicking a member of it adds to that same selection rather than replacing it.
  await page.locator('.grid__band .tile__hit').first().click({ modifiers: ['ControlOrMeta'] });
  // The bar counts photographs, so the stack's row already stands for all of its
  // members and the one clicked adds nothing to the total; the rings are two,
  // being the row and that member.
  await expect(page.locator('.bulkbar__count')).toHaveText(`${STACK_PHOTO_NAMES.length} selected`);
  await expect(page.locator('.tile--selected')).toHaveCount(2);

  // And one action reaches both. Two *entries* is the whole stack plus one of its
  // members, so the photographs are the stack's members and no more: the row
  // resolves to all of them, the member is already one of those, and the server
  // takes the union rather than acting on it twice.
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText(`Rebuilt ${STACK_PHOTO_NAMES.length} thumbnails`)).toBeVisible({ timeout: 30_000 });

  // Closing the band takes its members out of the selection, since a closed stack
  // would leave them acted on with nothing on screen saying so - and leaves the
  // rest of it alone, because opening and closing a stack is not a selection.
  await stack.click();
  await expect(page.locator('.grid__band')).toHaveCount(0);
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await stack.click();

  // A selection of nothing but members is a selection like any other: the runs are
  // empty and the ids carry it. The band is still open - a rebuild re-reads the
  // collection and keeps the bands it had (§19.6.1) - so a plain click on a member
  // is all it takes, which replaces the selection rather than adding to it.
  await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);
  await page.locator('.grid__band .tile__hit').first().click();
  await expect(page.locator('.tile--selected')).toHaveCount(1);
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText('Rebuilt 1 thumbnail')).toBeVisible({ timeout: 30_000 });
});

// The grid shows a stack as one tile; the viewer steps through every frame of it
// (§19.5.3). Previous/Next used to walk the *collapsed* listing, so the arrows
// skipped every member the stack did not stand for - and a member opened from a
// band had no row at all, which left both arrows dead with no way on.
test('the viewer steps through every member of a stack, not just its tile', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
  await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);

  // In through the middle member, which no listing has a row for: the case that
  // used to strand the reader with both arrows disabled.
  await page.locator('.grid__band .tile__hit').nth(1).dblclick();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  const middle = openPhotoId(page);

  const next = page.getByRole('button', { name: 'Next photo' });
  const previous = page.getByRole('button', { name: 'Previous photo' });
  await expect(previous).toBeEnabled({ timeout: 30_000 });
  await expect(next).toBeEnabled();

  // Step to either side and back: both are the stack's own members, so the walk
  // is through the stack rather than over it.
  await next.click();
  await expect(page).not.toHaveURL(new RegExp(middle));
  // And it is a step in the animation's eyes too, not just the arrows': the
  // direction is read off the run, so a member with no row in the listing still
  // slides in from the side the reader is heading towards.
  await expect(page.locator('.stage__viewport img.is-ready.is-stepping-next')).toBeVisible({ timeout: 60_000 });
  const after = openPhotoId(page);
  await previous.click();
  await expect(page).toHaveURL(new RegExp(middle));
  await expect(page.locator('.stage__viewport img.is-ready.is-stepping-prev')).toBeVisible({ timeout: 60_000 });
  await previous.click();
  const before = openPhotoId(page);

  const members = (await (await page.request.get(`${API_URL}/api/stacks/${await stackIdOfLibrary(page)}/photos`)).json()) as {
    id: string;
  }[];
  const ids = members.map((member) => member.id);
  expect(ids).toContain(after);
  expect(ids).toContain(before);
  expect(new Set([before, middle, after]).size).toBe(3);
});

test('a member picked out of the band can be removed from the stack', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
  await expect(page.locator('.grid__band .tile')).toHaveCount(STACK_PHOTO_NAMES.length);

  // Two of the three, so one member is left and the stack dissolves: a stack of
  // one is a photograph, and that is the half of this worth asserting.
  const members = page.locator('.grid__band .tile__hit');
  await members.nth(0).click();
  await members.nth(1).click({ modifiers: ['ControlOrMeta'] });
  const remove = page.getByRole('button', { name: 'Remove from stack' });
  await expect(remove).toBeVisible();
  await remove.click();

  // One member left is a photograph rather than a stack, so the badge goes and
  // the collection is ordinary tiles again.
  await expect(page.locator('.tile__stack')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.tile')).toHaveCount(STACK_PHOTO_NAMES.length);
});

test('a stack made by hand can be unstacked again', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, STACK_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(STACK_PHOTO_NAMES.length, { timeout: 45_000 });

  // Cmd-click, because a plain click means "this one instead" (§18.3.1). Waiting
  // on each selection rather than clicking straight through: the bulk bar appears
  // under the first one and moves the grid, so a blind loop can land a click on a
  // tile that is no longer where it was.
  const tiles = page.locator('.tile__hit');
  for (let index = 0; index < STACK_PHOTO_NAMES.length; index++) {
    await tiles.nth(index).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.tile--selected')).toHaveCount(index + 1);
  }
  await page.getByRole('button', { name: 'Stack', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);

  // Cmd-click: a plain click on a stack's tile opens its band rather than selecting
  // it, and Unstack is offered for a selection of one stack (§19.6).
  await page.locator('.tile__hit').click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('button', { name: 'Unstack' }).click();
  await expect(page.locator('.tile')).toHaveCount(STACK_PHOTO_NAMES.length);
});

// Taking the best parts of a burst, in the browser: the submenu reaches the page, a click on the
// picture seeds a tile and opens its popup, a pick closes it and grows a piece that opens it again,
// and Save leaves a photograph that survives a reload.
//
// **What is here is what only a browser can answer.** Every rule about a pick - which tiles follow
// the base, what undo takes back, when a seed is dropped again - is pinned against
// `MergePresenter` in `bun test`, in milliseconds. A screenshot of the canvas could say something
// changed and never that the value was right, which is the failure that actually happens.
import { expect, test } from '@playwright/test';
import { MERGE_PHOTOS_DIR, MERGE_PHOTO_NAMES } from '../fixture_library';
import { gotoLibrary, photoStage, selectPhoto, selectedTiles, tiles, useLibrary } from '../helpers';

// The analysis is minutes on a real burst and tens of seconds on this one, and Save renders the
// composite before it answers.
test.describe.configure({ timeout: 300_000, mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, MERGE_PHOTOS_DIR, { photos: MERGE_PHOTO_NAMES.length });
});

// First: a saved merge folds its frames under its own tile, leaving none to select.
test('Cancel leaves nothing behind', async ({ page }) => {
  await gotoLibrary(page, MERGE_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(MERGE_PHOTO_NAMES.length);

  // The whole burst: the synthetic frames have no capture dates, so which two lead the grid is up to
  // their ids, and a pair holding the last frame is too far apart for the corner check.
  for (let frame = 0; frame < MERGE_PHOTO_NAMES.length; frame += 1) {
    await selectPhoto(page, frame);
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge photos', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Take best parts', exact: true }).click();
  await expect(photoStage(page)).toHaveCSS('cursor', 'crosshair', { timeout: 240_000 });

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).not.toHaveURL(/\/photos\/merge\//);
  await expect(tiles(page)).toHaveCount(MERGE_PHOTO_NAMES.length);
});

const SEAMS = '/api/assemblies/seams';
const PREVIEW = '/api/assemblies/preview';

test('seed a tile, pick a frame for it, commit, and the result survives a reload', async ({ page }) => {
  // Every pick set the server solved, as it answered.
  const solved: number[][] = [];
  // Where each settled pick set was rendered, which only a real round trip answers.
  const rendered: string[] = [];
  page.on('response', async (response) => {
    if (!response.url().endsWith(PREVIEW) || !response.ok()) return;
    const answer = (await response.json().catch(() => null)) as { url?: string } | null;
    if (answer?.url != null) rendered.push(answer.url);
  });
  page.on('response', async (response) => {
    if (!response.url().endsWith(SEAMS) || !response.ok()) return;
    // A solve answering after Save navigated away has no body left to read.
    const answer = (await response.json().catch(() => null)) as { seams: ({ pick: number[] } | null)[] | null } | null;
    for (const seams of answer?.seams ?? []) if (seams != null) solved.push(seams.pick);
  });
  await gotoLibrary(page, MERGE_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(MERGE_PHOTO_NAMES.length);

  for (let frame = 0; frame < MERGE_PHOTO_NAMES.length; frame += 1) {
    await selectPhoto(page, frame);
  }
  await expect(selectedTiles(page)).toHaveCount(MERGE_PHOTO_NAMES.length);

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge photos', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Take best parts', exact: true }).click();
  await expect(page).toHaveURL(/\/photos\/merge\//);

  await expect(photoStage(page)).toHaveCSS('cursor', 'crosshair', { timeout: 240_000 });
  // The analysis hands back no tiles: every one is seeded by a click.
  const pieces = photoStage(page).getByRole('button', { name: /^Tile \d+$/ });
  await expect(pieces).toHaveCount(0);

  // A real click at a real point: where it lands on the picture is layout a jsdom render has none of.
  const box = (await photoStage(page).locator('svg').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('dialog')).toBeVisible();

  // A seed starts on the base, and picking that again moves nothing.
  const other = page.getByRole('dialog').getByRole('button', { name: /^Choose frame \d+$/, pressed: false }).first();
  const source = Number((await other.getAttribute('aria-label'))?.match(/\d+/)?.[0]) - 1;
  await other.click();
  await expect(page.getByRole('dialog')).toBeHidden();
  // Solved for on the server over the analysis's volume - asked for when the seed opened, so its
  // answer may already be in hand by the click.
  await expect.poll(() => solved.some((pick) => pick.includes(source))).toBe(true);

  // And the picks the reader has settled on come back as the render itself (§4.1), which the page
  // draws over the masked composite. Fetched as a picture, so the file has to be there to decode.
  await expect.poll(() => rendered.length, { timeout: 240_000 }).toBeGreaterThan(0);
  const settled = await page.request.get(rendered.at(-1)!);
  expect(settled.ok()).toBe(true);
  expect(settled.headers()['content-type']).toBe('image/avif');

  // The grown piece is drawn, and SVG hit-testing on it opens the seed again.
  await expect(pieces.first()).toBeAttached();
  await pieces.first().click({ force: true });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  const lines = page.getByRole('button', { name: 'Show or hide tile lines' });
  await lines.click();
  await expect(pieces.first()).toHaveCSS('stroke-opacity', '0');
  await lines.click();
  await expect(pieces.first()).not.toHaveCSS('stroke-opacity', '0');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/photos\/[a-z0-9]+$/, { timeout: 240_000 });

  await page.reload();
  await expect(photoStage(page)).toBeVisible({ timeout: 120_000 });

  // In the grid the merge goes unnamed, and its badge still opens the frames it was made from.
  await gotoLibrary(page, MERGE_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).getByText(`Merge of ${MERGE_PHOTO_NAMES.length} photos`, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Show the ${MERGE_PHOTO_NAMES.length} frames of this merge` }).click();
  await expect(page.getByRole('group', { name: `${MERGE_PHOTO_NAMES.length} frames of this merge` })).toBeVisible();
});

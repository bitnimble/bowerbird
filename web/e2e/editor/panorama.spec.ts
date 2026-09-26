import { type Locator, type Page, expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PANORAMA_PHOTOS_DIR, PANORAMA_PHOTO_NAMES } from '../fixture_library';
import { editDiagnosticSize, editDiagnostics, editPreview, editTools, photoStage, savedRev, useLibrary, waitForEditorLive } from '../helpers';

// A composite opened in the editor, which is the one claim about it a browser can answer.
//
// **The editor does not decode this one.** A panorama is several photographs and a canvas larger
// than a tab will hold, so the picture is prepared where its frames are and crosses coded - and
// what has to be true here is that a real device took those samples and drew them. Everything
// about *what the picture looks like* is native's: `composite_job`'s own fixtures compare a composite
// against the rendition of it, in milliseconds, where a screenshot here could only say that
// something changed.
//
// Six synthetic views of one world, because no RAW fixture is a pan. They are PNGs, so the library
// has to be told to take them and no camera match is fitted - the recipe is stated in the
// corrected geometry a finished picture is already in.
test.describe.configure({ timeout: 300_000, mode: 'serial' });

let panoramaId = '';

test.beforeAll(async ({ browser }) => {
  // The views are PNGs, which a library ignores unless it is told to take them.
  await useLibrary(browser, PANORAMA_PHOTOS_DIR, {
    photos: PANORAMA_PHOTO_NAMES.length,
    includeNonRaw: true,
  });

  const page = await browser.newPage();
  // Through the API rather than the interface: what this file is about is the editor, and the
  // merge is a long call with a progress stream of its own.
  const libraries = await page.request.get(route(PathSegment.api(), PathSegment.libraries()));
  const found = ((await libraries.json()) as { id: string; root_path: string }[]).find(
    (library) => library.root_path === PANORAMA_PHOTOS_DIR,
  );
  if (found == null) throw new Error('the panorama library was not added');

  const listed = await page.request.get(
    `${route(PathSegment.api(), PathSegment.libraries(), found.id, PathSegment.photos())}?limit=100`,
  );
  const { photos } = (await listed.json()) as { photos: { id: string; composite_kind?: string | null }[] };
  const frames = photos.filter((photo) => photo.composite_kind == null).map((photo) => photo.id);
  expect(frames.length).toBe(PANORAMA_PHOTO_NAMES.length);

  // Aligns the set and builds the composite's renditions before it answers, so this is the slow
  // call in the file.
  const merged = await page.request.post(route(PathSegment.api(), PathSegment.composites(), PathSegment.panorama()), {
    data: { photo_ids: frames },
    timeout: 240_000,
  });
  expect(merged.ok(), `the merge failed: ${await merged.text()}`).toBe(true);
  panoramaId = ((await merged.json()) as { photoId: string }).photoId;
  await page.close();
});

async function openComposite(page: Page): Promise<void> {
  await page.goto(route(PathSegment.photos(), panoramaId, PathSegment.edit()));
  await waitForEditorLive(page, 240_000);
}

function tool(page: Page, name: 'Cursor' | 'Loupe' | 'Crop' | 'Remove'): Locator {
  return editTools(page).getByRole('radio', { name });
}

test('a panorama opens in the editor and draws on a real device', async ({ page }) => {
  await openComposite(page);

  // The adapter is the one piece of evidence that a device was acquired rather than silently
  // skipped, and the size is the picture the prepare answered with.
  await expect(editDiagnostics(page)).toHaveAttribute('data-adapter', /./);
  const [width, height] = await editDiagnosticSize(page, 'data-size');
  // A 220-degree sweep of a 60-degree lens, so the canvas is wide and shallow - and past the 4096
  // a whole prepared level is bounded by, which is what gives it a rung to zoom into.
  expect(width).toBeGreaterThan(4096);
  expect(height).toBeGreaterThan(300);
});

/** How much of the picture a region ask covers across, as a fraction. 1 where it asked for all. */
function regionWidth(url: string): number {
  const region = new URL(url, 'http://library.test').searchParams.get('region');
  const width = Number(region?.split(',')[2]);
  return Number.isFinite(width) ? width : 1;
}

/** Whether a prepare named a level and a rectangle of it, which is what a tile fetch is. */
function isTileFetch(url: string): boolean {
  const query = new URL(url, 'http://library.test').searchParams;
  return query.get('at') != null && query.get('level') != null;
}

test('zooming in fetches a finer level, and a pan after it fetches tiles', async ({ page }) => {
  // **The ladder, in the one place only a browser can answer it.** Which level a region resolves to
  // and which tiles a rectangle needs are pure functions pinned in `bun test` and in the native
  // suite; what needs a real device is that pictures arriving mid-open are cut into tiles, copied
  // into one frame on the stage the page transferred at the open, graded and drawn. A swap that
  // goes wrong leaves a canvas that is black rather than one that is wrong.
  const prepares: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(route(PathSegment.prepare()))) prepares.push(request.url());
  });

  await openComposite(page);
  // The open asks for nothing: which level the whole picture fits at is the server's alone.
  await expect.poll(() => prepares.length, { timeout: 60_000 }).toBeGreaterThan(0);
  expect(prepares[0]).not.toContain('region=');
  // It may well ask again straight away, and that is the ladder working rather than a fault: this
  // canvas's coarsest level is a halving, so a stage with more pixels than the level has samples
  // across it is magnifying from the first frame. What the zoom below has to do is ask for *less*
  // of the picture than whatever it settles on here.
  await page.waitForTimeout(1500);
  const before = Math.min(...prepares.map(regionWidth));

  // The keyboard's way to the zoom stops, which is a window listener the stage installs.
  await page.keyboard.press('+');
  await page.keyboard.press('+');

  // A finer level, asked for as fractions of the picture and the pixels the stage has to draw them
  // on. Half or less, because a zoom stop is not a nudge.
  await expect
    .poll(() => Math.min(...prepares.map(regionWidth)), { timeout: 60_000 })
    .toBeLessThan(before / 2);

  // **And the pan after it costs tiles rather than a window**, which is the whole point of the
  // grid: the level is in hand, so what is asked for is the rectangle the module says it is short
  // of, named in that level's own pixels.
  const settled = prepares.length;
  // A real drag, because the stage's pan is a pointer gesture and nothing else reaches it - the
  // keys it binds are the zoom stops and fullscreen.
  const viewport = await photoStage(page).boundingBox();
  if (viewport == null) throw new Error('the stage has no viewport to drag');
  const middle = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  // Far enough to leave the quarter-viewport `TILE_REACH` keeps in hand, in steps, since a pan is
  // a stream of moves and one jump can read as a click.
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(middle.x - (viewport.width / 2) * (step / 8), middle.y);
  }
  await page.mouse.up();

  await expect
    .poll(() => prepares.slice(settled).some(isTileFetch), { timeout: 60_000 })
    .toBe(true);

  // And the reader is still looking at the picture rather than at a black stage: the editor stays
  // live, which is what a failed swap or a frame assembled out of nothing would end.
  await waitForEditorLive(page, 10_000);
  // The picture's own size does not move with the level, which is what keeps their zoom.
  const [width] = await editDiagnosticSize(page, 'data-size');
  expect(width).toBeGreaterThan(4096);
});

/**
 * A removal on a composite, zoomed: the search runs over the tiles the tab holds of a level, grown to
 * what it reads, and the fill kept is drawn over them - the module's own path for a picture that
 * arrived without its repairs, which nothing but a browser holding tiles reaches.
 */
test('a loop drawn on a zoomed panorama is offered fills, and one is kept', async ({ page }) => {
  await openComposite(page);
  const wasAt = await savedRev(page, panoramaId);
  const details = page.getByRole('region', { name: 'Photo details' });

  await tool(page, 'Remove').click();
  await page.keyboard.press('+');
  await expect(editPreview(page)).toHaveCSS('cursor', 'grab');
  // The tool's surface covers the stage.
  const box = await photoStage(page).boundingBox();
  if (box == null) throw new Error('the editor has no stage');
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const radius = Math.min(box.width, box.height) / 25;
  await page.mouse.move(centre.x + radius, centre.y);
  await page.mouse.down();
  for (let step = 1; step <= 24; step++) {
    const angle = (step / 24) * Math.PI * 2;
    await page.mouse.move(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle));
  }
  await page.mouse.up();

  const apply = details.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeVisible({ timeout: 120_000 });
  await apply.click();
  await expect.poll(async () => savedRev(page, panoramaId), { timeout: 30_000 }).not.toBe(wasAt);
  await waitForEditorLive(page, 10_000);

  const kept = details.getByRole('button', { name: 'Edit removal 1' });
  await expect(kept.locator('img')).toBeVisible({ timeout: 30_000 });

  // Reopened, and searched again off the picture without it.
  await kept.click();
  await expect(apply).toBeVisible({ timeout: 120_000 });
  await waitForEditorLive(page, 10_000);
  await details.getByRole('button', { name: 'Cancel', exact: true }).click();

  await details.getByRole('button', { name: 'Delete removal 1' }).click();
  await expect(kept).toBeHidden();
  await tool(page, 'Cursor').click();
});

/**
 * A Detail setting on a composite is prepared again on the server, which is where it runs: the
 * picture there is asked for at the setting the reader has not saved yet, the tiles held at the
 * old one are let go, and the editor keeps drawing. What the setting does is native's.
 */
test('moving the sharpening prepares the picture again at it', async ({ page }) => {
  const prepares: URL[] = [];
  page.on('request', (request) => {
    if (request.url().includes(route(PathSegment.prepare()))) prepares.push(new URL(request.url()));
  });
  await openComposite(page);
  const wasAt = await savedRev(page, panoramaId);

  await page.getByRole('slider', { name: 'Sharpening' }).focus();
  await page.keyboard.press('PageUp');

  await expect
    .poll(() => prepares.some((url) => url.searchParams.get('develop') != null), { timeout: 60_000 })
    .toBe(true);
  await expect.poll(async () => savedRev(page, panoramaId), { timeout: 30_000 }).not.toBe(wasAt);
  await waitForEditorLive(page, 10_000);

  await page.getByRole('group', { name: 'Photo controls' }).getByRole('button', { name: 'Undo' }).click();
  await waitForEditorLive(page, 10_000);
});

test('the glass is not offered for a picture prepared elsewhere', async ({ page }) => {
  await openComposite(page);

  // A loupe claims to be the export's own pixels, and what a backend open holds is the picture at
  // a level - so the tool goes rather than showing something the export is not. The rest of the
  // toolbar stays, which is what makes this a choice rather than a broken panel.
  await expect(tool(page, 'Loupe')).toHaveCount(0);
  await expect(tool(page, 'Crop')).toBeVisible();
  await expect(tool(page, 'Remove')).toBeVisible();
  await expect(tool(page, 'Cursor')).toBeVisible();
});

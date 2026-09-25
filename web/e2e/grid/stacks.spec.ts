import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { API_URL, E2E_ROOT, STACK_PHOTO_NAMES, STACK_PHOTOS_DIR, stackPhotosUrl } from '../fixture_library';
import {
  FIRST_FRAME,
  addLibrary,
  bands,
  bulkAction,
  frames,
  fusedBands,
  gotoLibrary,
  openPhotoId,
  photoStage,
  picks,
  rowTiles,
  selectedTiles,
  selectionBar,
  selectionCount,
  setViewMode,
  shownFrame,
  stackFrames,
  ticked,
  tiles,
  toggleExpandStacks,
} from '../helpers';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '../../../test/fixtures');
const SEAM_ARW = path.join(FIXTURES, 'DSC02981.ARW');
const SEAM_CR3 = path.join(FIXTURES, 'IMG_5360.CR3');

/** The one stack in this spec's library, found through the collapsed listing. */
async function stackIdOfLibrary(page: Page): Promise<string> {
  const libraries = (await (
    await page.request.get(`${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`)
  ).json()) as { id: string; root_path: string }[];
  const library = libraries.find((entry) => entry.root_path === STACK_PHOTOS_DIR);
  if (library == null) throw new Error('the stack library is not listed');
  const rows = (await (
    await page.request.get(
      `${API_URL}${route(PathSegment.api(), PathSegment.libraries(), library.id, PathSegment.photos())}?limit=50`,
    )
  ).json()) as {
    photos: { stack_id: string | null }[];
  };
  return rows.photos.find((photo) => photo.stack_id != null)?.stack_id ?? '';
}

const members = (page: Page) => bands(page).getByRole('listitem');

/** Which way the picture on the stage slid in from, while it is still sliding. */
const slidFrom = (page: Page): Promise<string | null> =>
  photoStage(page).evaluate((stage) => {
    const picture = stage.querySelector('[role="img"]:not([aria-hidden="true"])')?.parentElement;
    const [move] = picture?.getAnimations() ?? [];
    return ((move?.effect as KeyframeEffect | undefined)?.getKeyframes()[0]?.translate as string | undefined) ?? null;
  });

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
  // Detection runs as part of settling, so the grid has to be opened after it
  // rather than during the import.
  await addLibrary(page, STACK_PHOTOS_DIR, { autoStack: true, photos: STACK_PHOTO_NAMES.length });
  await gotoLibrary(page, STACK_PHOTOS_DIR);

  await expect(tiles(page)).toHaveCount(1, { timeout: 45_000 });
  await expect(stackFrames(page)).toHaveAccessibleName(new RegExp(`stack of ${STACK_PHOTO_NAMES.length},`));
});

// Where the members sit inside the band is `bands.spec.ts`.
test('the tile opens a band below the row in every view, and closes it again', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  const tile = frames(rowTiles(page));
  await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });

  for (const view of ['Masonry', 'List', 'Grid'] as const) {
    await setViewMode(page, view);
    // Masonry packs from each photo's shape rather than on a row model, and used
    // to offer no way into a stack at all.
    await expect(stackFrames(page)).toBeVisible();
    const before = (await rowTiles(page).boundingBox())!;

    await tile.click();
    await expect(bands(page)).toHaveCount(1);
    await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);
    // The stack's own tile stays where it is, now marked as what closes the band.
    await expect(stackFrames(page)).toHaveAttribute('aria-expanded', 'true');
    // Joined to the tile that opened it in every view, masonry included - where the
    // tile's place on its line has to be measured before the edge can be cut.
    await expect.poll(() => fusedBands(page)).toBe(1);
    // The band is a full-width item after the line its tile sits on, so nothing on
    // that line changes size: in masonry, a band that broke the line where the tile
    // was handed it the width the band took, stretching the stack across the grid.
    expect((await rowTiles(page).boundingBox())!.width).toBeCloseTo(before.width, 0);

    await tile.click();
    await expect(bands(page)).toHaveCount(0);
  }
});

// A scaled display puts the page on a fractional device pixel ratio, which is where
// a shape ending exactly on the edge that clips it stops being free: both rasterise
// half-covering one device row, and what survives is a faint line along an edge
// nothing meant to draw. The joined shape is made of two of those - the tile's own
// three-sided ring, and the cut in the band's top edge - so a purple pixel anywhere
// down the seam between them is the hairline back (§19.6).
test.describe('a joined stack at a fractional device ratio', () => {
  test.use({ deviceScaleFactor: 1.7777777 });

  // Whether a part-covered row is visible at all depends on where the edge falls
  // inside a device pixel, so the seam is read at several widths rather than one.
  const WIDTHS = [1280, 1101, 953, 871];
  // A column wide, where the one cut reaches both ends of the band and the right-hand
  // end of the top edge is cut square rather than kept whole.
  const ONE_COLUMN = 420;

  /**
   * Anything drawn in the band's colour down the seam between a stack's tile and
   * the band joined to it, at the tile's own midpoint.
   *
   * A column, not a box: both hairlines this guards against run the whole width of
   * the tile, and a column costs one screenshot.
   */
  async function seamColours(page: Page): Promise<string[]> {
    const open = rowTiles(page).filter({ has: page.getByRole('button', { name: /stack of \d+/, expanded: true }) });
    const tile = (await open.boundingBox())!;
    // From inside the tile's own cell edge to inside the band's: the pad either
    // side of the seam is the bed the grid sits on, so it is all meant to be grey.
    const seam = await page.screenshot({
      clip: { x: tile.x + tile.width / 2, y: tile.y + tile.height - 3, width: 1, height: 9 },
      scale: 'device',
    });
    return page.evaluate(async (encoded: string) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const found: string[] = [];
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          const at = (y * image.width + x) * 4;
          const [r, g, b] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
          if (b > 40 && b - g > 12 && b > r + 8) found.push(`row ${y}: ${r},${g},${b}`);
        }
      }
      return found;
    }, seam.toString('base64'));
  }

  // Masonry as well as grid: there the cut is measured off the tile's place on its
  // line rather than worked out from a column, so it rounds where the other is exact.
  async function expectCleanSeam(page: Page, widths: number[]): Promise<void> {
    for (const view of ['Grid', 'Masonry'] as const) {
      await setViewMode(page, view);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 720 });
        await expect.poll(() => fusedBands(page)).toBe(1);
        expect(await seamColours(page), `the band colour in ${view} at ${width}px, on the edge neither draws`).toEqual(
          [],
        );
      }
    }
    await setViewMode(page, 'Grid');
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  test('draws nothing along the edge its tile and its band share', async ({ page }) => {
    await gotoLibrary(page, STACK_PHOTOS_DIR);
    await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });
    await frames(rowTiles(page)).click();
    await expect.poll(() => fusedBands(page)).toBe(1);

    await expectCleanSeam(page, [...WIDTHS, ONE_COLUMN]);

    await frames(rowTiles(page)).click();
    await expect(bands(page)).toHaveCount(0);
  });

  // The stack this library opens has a tile on either side of it, which is the shape
  // the cut is hardest at: both ends of the gap are interior corners with a fillet
  // bridging the row gap, and neither end of the top edge is the band's own. The one
  // shape `STACK_PHOTOS_DIR` cannot make - every frame in it is a copy of the same
  // RAW, so they are one stack, and its tile is always the first of the row.
  test('draws nothing along that edge with a tile either side of it', async ({ page }, info) => {
    const dir = path.join(E2E_ROOT, `seam-photos-${info.project.name}`);
    mkdirSync(dir, { recursive: true });
    // Two frames from each of two cameras: alike enough to stack in pairs, and far
    // enough apart that the pairs are two stacks rather than one.
    for (const [name, source] of [
      ['DSC09101.ARW', SEAM_ARW],
      ['DSC09102.ARW', SEAM_ARW],
      ['IMG_0001.CR3', SEAM_CR3],
      ['IMG_0002.CR3', SEAM_CR3],
    ] as const) {
      copyFileSync(source, path.join(dir, name));
    }
    await addLibrary(page, dir, { autoStack: true, photos: 4 });
    await gotoLibrary(page, dir);
    await expect(stackFrames(page).first()).toBeVisible({ timeout: 60_000 });

    // The second of the two, so the tile it opens is not the first of its row.
    await stackFrames(rowTiles(page)).last().click();
    const band = bands(page);
    await expect(band).toHaveCount(1);
    await expect.poll(() => fusedBands(page)).toBe(1);
    // Neither end of the top edge is the band's own, so both corners keep their curve.
    await expect(band).not.toHaveCSS('border-top-left-radius', '0px');
    await expect(band).not.toHaveCSS('border-top-right-radius', '0px');

    await expectCleanSeam(page, WIDTHS);
  });
});

test('a list row opens its stack from anywhere along it, not just the thumbnail', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });
  await setViewMode(page, 'List');

  // Clicked past the thumbnail, which is most of a list row and used to be dead
  // space: through the mouse rather than the locator, because the point of this
  // is which element the click lands on and Playwright would refuse to click one
  // that hands its clicks to the row.
  const row = (await rowTiles(page).first().boundingBox())!;
  await page.mouse.click(row.x + row.width - 40, row.y + row.height / 2);
  await expect(bands(page)).toHaveCount(1);
  // A member row says as much about itself as any other row does.
  await expect(members(page).first().getByText(/\d{4}/)).toBeVisible();

  await setViewMode(page, 'Grid');
  await frames(rowTiles(page)).click();
  await expect(bands(page)).toHaveCount(0);
});

// One selection, whether a photo was chosen in the grid or inside an open stack:
// a member has no position to be in a run, so it travels by id beside them
// (§19.6.1).
test('a selection spans the grid and the contents of a stack', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  const stack = frames(rowTiles(page));
  await stack.click();
  await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);
  // Opening it selected nothing: a stack's tile is a disclosure (§19.6). Cmd-click
  // is what selects the row, and it leaves the band open.
  await expect(selectedTiles(page)).toHaveCount(0);
  await stack.click({ modifiers: ['ControlOrMeta'] });
  await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);

  // The row stands for every photograph under it (§19.6.1), so the open band is a
  // band of chosen photographs: the rings are the row and all of its members. The
  // stack is the whole of this library, so the bar says so rather than counting.
  await expect(selectionCount(page)).toHaveText('all selected');
  await expect(selectedTiles(page)).toHaveCount(STACK_PHOTO_NAMES.length + 1);

  // Cmd-clicking one of them takes that frame out and leaves the rest. The row
  // cannot say that - it is the whole stack or none of it - so it stops standing
  // for the stack and the members it named carry the selection instead.
  await frames(bands(page)).first().click({ modifiers: ['ControlOrMeta'] });
  await expect(selectionCount(page)).toHaveText(`${STACK_PHOTO_NAMES.length - 1} selected`);
  await expect(selectedTiles(page)).toHaveCount(STACK_PHOTO_NAMES.length - 1);

  // Closing the band takes its members out of the selection, since a closed stack
  // would leave them acted on with nothing on screen saying so.
  await stack.click();
  await expect(bands(page)).toHaveCount(0);
  await expect(selectedTiles(page)).toHaveCount(0);
  await stack.click();
  await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);

  // And the row resolves to the stack when an action runs off it: one entry, every
  // photograph in it, and the server takes each once.
  await stack.click({ modifiers: ['ControlOrMeta'] });
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText(`Queued ${STACK_PHOTO_NAMES.length} thumbnails to rebuild.`)).toBeVisible({ timeout: 30_000 });
  // The action consumed what it acted on, so the bar goes with it (§18.3.1).
  await expect(selectedTiles(page)).toHaveCount(0);
  await expect(selectionBar(page)).toBeHidden();

  // A selection of nothing but members is a selection like any other: the runs are
  // empty and the ids carry it. The band is still open - a rebuild re-reads the
  // collection and keeps the bands it had (§19.6.1) - so ticking one member is all
  // it takes.
  await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);
  await picks(bands(page)).first().click();
  await expect(selectedTiles(page)).toHaveCount(1);
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText('Queued 1 thumbnail to rebuild.')).toBeVisible({ timeout: 30_000 });
});

// A band takes a run like the grid does, over its own order. Here rather than
// against the presenter because what is in question is the modifier reaching the
// handler from a real click, on the frame and on the tick box alike.
test('shift-click spans the members of an open band, and back out of it', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  await frames(rowTiles(page)).click();
  const band = members(page);
  await expect(band).toHaveCount(STACK_PHOTO_NAMES.length);
  const ticks = picks(bands(page));
  const chosen = (): Promise<boolean[]> => ticked(band, STACK_PHOTO_NAMES.length);

  await ticks.first().click();
  await frames(band.last()).click({ modifiers: ['Shift'] });
  expect(await chosen()).toEqual([true, true, true]);

  // And the anchor's verb carries here too: unpick the last and span back, and
  // that stretch leaves rather than being put back in.
  await ticks.last().click();
  await ticks.nth(1).click({ modifiers: ['Shift'] });
  expect(await chosen()).toEqual([true, false, false]);
});

// The collapse taken off the listing itself (§19.5.4), which is a different thing
// from opening every band: there is no stack in the grid to open.
test('expanding all stacks puts every frame in the grid, and keeps what was selected', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });

  // Cmd-click, because a plain click on a stack's tile opens its band (§19.6).
  // The row it selects stands for every photograph in the stack.
  await frames(rowTiles(page)).click({ modifiers: ['ControlOrMeta'] });
  await expect(selectedTiles(page)).toHaveCount(1);

  await toggleExpandStacks(page);
  // One tile per photograph, none of them marked as a stack and no band anywhere:
  // it looks like a library that never had one.
  await expect(tiles(page)).toHaveCount(STACK_PHOTO_NAMES.length);
  await expect(stackFrames(page)).toHaveCount(0);
  await expect(bands(page)).toHaveCount(0);
  // Every position in the collection moved, and the selection came with it: the
  // one row that stood for the stack is now its members, all of them ringed.
  await expect(selectedTiles(page)).toHaveCount(STACK_PHOTO_NAMES.length);

  await toggleExpandStacks(page);
  await expect(tiles(page)).toHaveCount(1);
  await expect(stackFrames(page)).toBeVisible();
  await expect(selectedTiles(page)).toHaveCount(1);
});

// The grid shows a stack as one tile; the viewer steps through every frame of it
// (§19.5.3). Previous/Next used to walk the *collapsed* listing, so the arrows
// skipped every member the stack did not stand for - and a member opened from a
// band had no row at all, which left both arrows dead with no way on.
test('the viewer steps through every member of a stack, not just its tile', async ({ page }) => {
  // Four decodes in one test - the way in, then a step either side and back - and each is a
  // rendition read off disk on a machine running the rest of the suite beside it. The default
  // sixty seconds is the one budget here that is not generous.
  test.setTimeout(240_000);
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });
  await frames(rowTiles(page)).click();
  await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);

  // In through the middle member, which no listing has a row for: the case that
  // used to strand the reader with both arrows disabled.
  await frames(bands(page)).nth(1).click();
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
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
  //
  // Read off the picture on screen, not the one leaving, and only once the step has
  // decoded - so this waits on a decode however fast the URL moved. Polled finely: the
  // slide is over in a fraction of a second.
  await expect.poll(() => slidFrom(page), { ...FIRST_FRAME, intervals: [20] }).toBe('22px');
  const after = openPhotoId(page);
  await previous.click();
  await expect(page).toHaveURL(new RegExp(middle));
  await expect.poll(() => slidFrom(page), { ...FIRST_FRAME, intervals: [20] }).toBe('-22px');
  await previous.click();
  const before = openPhotoId(page);

  const stacked = (await (await page.request.get(stackPhotosUrl(await stackIdOfLibrary(page)))).json()) as {
    id: string;
  }[];
  const ids = stacked.map((member) => member.id);
  expect(ids).toContain(after);
  expect(ids).toContain(before);
  expect(new Set([before, middle, after]).size).toBe(3);
});

test('a member picked out of the band can be removed from the stack', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  await frames(rowTiles(page)).click();
  await expect(members(page)).toHaveCount(STACK_PHOTO_NAMES.length);

  // Two of the three, so one member is left and the stack dissolves: a stack of
  // one is a photograph, and that is the half of this worth asserting.
  await picks(bands(page)).nth(0).click();
  await frames(bands(page)).nth(1).click({ modifiers: ['ControlOrMeta'] });
  const remove = page.getByRole('button', { name: 'Remove from stack' });
  await expect(remove).toBeVisible();
  await remove.click();

  // One member left is a photograph rather than a stack, so the badge goes and
  // the collection is ordinary tiles again.
  await expect(stackFrames(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(tiles(page)).toHaveCount(STACK_PHOTO_NAMES.length);
});

// A stack made by hand, in a selection beside a loose frame: the stack comes apart
// and the loose frame is left alone.
test('a stack made by hand is taken apart by Unstack, beside a photo that is not one', async ({ page }) => {
  await gotoLibrary(page, STACK_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(STACK_PHOTO_NAMES.length, { timeout: 45_000 });

  // Two of the three fused, so the collection is one stack row and one loose
  // photograph - which is the mixed selection this is about.
  for (let index = 0; index < 2; index++) {
    await frames(page).nth(index).click({ modifiers: ['ControlOrMeta'] });
    await expect(selectedTiles(page)).toHaveCount(index + 1);
  }
  await bulkAction(page, 'Stack');
  await expect(tiles(page)).toHaveCount(STACK_PHOTO_NAMES.length - 1);

  await frames(page).first().click({ modifiers: ['ControlOrMeta'] });
  await frames(page).last().click({ modifiers: ['ControlOrMeta'] });
  await expect(selectedTiles(page)).toHaveCount(2);
  await bulkAction(page, 'Unstack');
  await expect(tiles(page)).toHaveCount(STACK_PHOTO_NAMES.length);
  await expect(stackFrames(page)).toHaveCount(0);
});

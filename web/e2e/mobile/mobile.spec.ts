import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHONE_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import {
  editPreview,
  editTools,
  firstPhotoId,
  gallery,
  gotoLibrary,
  gotoPhoto,
  openPhoto,
  photoStage,
  shownFrame,
  tiles,
  useLibrary,
  waitForEditorLive,
} from '../helpers';

// A phone: no keyboard to step with and no room for a column beside the photo,
// which is what everything below is about.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// Long because one spec opens a RAW: the decode is the same cold open
// `editor/raw_editing.spec.ts` gives three minutes for, and the config's default 60s would kill it
// however patient the poll inside it is.
test.describe.configure({ timeout: 180_000 });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, PHONE_PHOTOS_DIR);
});

// Playwright's touchscreen taps and nothing else, and a mouse drag is a mouse
// however the context is configured, so a real finger is driven through CDP:
// what the stage answers to is pointer events, and only this produces them with
// the gesture handling a browser really applies to a touch.
async function swipe(page: Page, from: { x: number; y: number }, dx: number, dy = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (const step of [0.3, 0.6, 1]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + dx * step, y: from.y + dy * step }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// Two fingers, moved apart or together. The same CDP path as `swipe` and for the
// same reason: only a real touch produces the pointer events the gesture reads.
async function pinch(page: Page, centre: { x: number; y: number }, from: number, to: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const points = (spread: number): { x: number; y: number; id: number }[] => [
    { x: centre.x - spread / 2, y: centre.y, id: 1 },
    { x: centre.x + spread / 2, y: centre.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + (to - from) * step) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function openFirstPhoto(page: Page): Promise<void> {
  await gotoPhoto(page, PHONE_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
}

// The drawer, hidden or not.
function drawer(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Sidebar', includeHidden: true });
}

function photoControls(page: Page): Locator {
  return page.getByRole('group', { name: 'Photo controls' });
}

function sheet(page: Page): Locator {
  return page.getByRole('region', { name: 'Photo details' });
}

const PANELS = /^(Notes|Edits|Camera|Rendition details|Original)$/;

/** A point on the grid, which is the page the gesture is for. */
async function onTheGrid(page: Page): Promise<{ x: number; y: number }> {
  await gotoLibrary(page, PHONE_PHOTOS_DIR);
  await expect(tiles(page).first()).toBeVisible({ timeout: 45_000 });
  const grid = await gallery(page).boundingBox();
  if (grid == null) throw new Error('the grid has no box');
  return { x: grid.x + 60, y: grid.y + grid.height / 2 };
}

// The sidebar is a drawer here, and the button that opens it is one target on a page
// otherwise given over to photographs. Over the grid, whose scroller claims the touch as soon
// as it reads it as a scroll, which cancels the pointer stream and left the first version of
// this working everywhere except the photographs.
test('a swipe rightwards opens the sidebar over the grid, and one back leftwards closes it', async ({ page }) => {
  const at = await onTheGrid(page);
  const sidebar = drawer(page);
  await expect(sidebar).not.toBeVisible();

  // Mid-page rather than at the edge: there is no strip to find. Past half the drawer's
  // width, so letting go settles it open rather than putting it back.
  await swipe(page, at, 160);
  await expect(sidebar).toBeVisible();

  await swipe(page, { x: 200, y: at.y }, -160);
  await expect(sidebar).not.toBeVisible();

  // Short of halfway it goes back where it came from, however far the finger got.
  await swipe(page, at, 60);
  await expect(sidebar).not.toBeVisible();
});

// The drag is the animation: how far out the drawer is has to be where the finger has got
// to, which is only observable while one is still down.
test('the drawer follows the finger rather than snapping open at the end', async ({ page }) => {
  const at = await onTheGrid(page);
  const sidebar = drawer(page);
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x + 80, y: at.y }] });

  // Held 80px in, against a 280px drawer: part way out, and the rest of it still off the
  // left edge. Both halves of that matter - a snap would have it fully in or fully out.
  const box = await sidebar.boundingBox();
  if (box == null) throw new Error('the sidebar has no box');
  expect(box.x).toBeLessThan(0);
  expect(box.x + box.width).toBeGreaterThan(70);
  expect(box.x + box.width).toBeLessThan(90);

  // And 80 of 280 is short of halfway, so letting go there puts it back.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(sidebar).not.toBeVisible();
});

test('swiping the frame steps to the next photo and back', async ({ page }) => {
  await openFirstPhoto(page);
  const first = page.url();

  const box = await photoStage(page).boundingBox();
  if (box == null) throw new Error('the stage has no box');
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await swipe(page, middle, -160);
  await expect(page).not.toHaveURL(first);
  // Stepping is the whole gesture: a swipe that also read as a tap would land on
  // the next photo zoomed in.
  await expect(shownFrame(page)).toHaveCSS('cursor', 'zoom-in');

  await swipe(page, middle, 160);
  await expect(page).toHaveURL(first);

  // A rightward drag anywhere else opens the sidebar, so the stage has to be exempt or every
  // step back through the photographs would pull the drawer over the one it landed on.
  await expect(drawer(page)).not.toBeVisible();

  // A pointer is a pointer: the same drag with a mouse, which is what a narrow
  // desktop window has, steps the same way.
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x - 160, middle.y, { steps: 4 });
  await page.mouse.up();
  await expect(page).not.toHaveURL(first);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'zoom-in');
});

// The system back gesture is history.back, so a run of swipes would otherwise be
// a run of presses to get out of. Two photographs is enough to ask it: with an
// entry per swipe, Back lands on the first one rather than on the grid.
test('a back press leaves the viewer rather than walking back through the swipes', async ({ page }) => {
  await gotoLibrary(page, PHONE_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  const grid = page.url();
  await openPhoto(page);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  const first = page.url();
  const depth = await page.evaluate(() => history.length);

  const box = await photoStage(page).boundingBox();
  if (box == null) throw new Error('the stage has no box');
  await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, -160);
  await expect(page).not.toHaveURL(first);
  const swiped = page.url();
  // The run occupies the one entry the grid pushed, however far it goes.
  expect(await page.evaluate(() => history.length)).toBe(depth);

  await page.goBack();
  await expect(page).toHaveURL(grid);
  // So Forward returns to the photograph that was on screen, rather than to the
  // one the run was entered at.
  await page.goForward();
  await expect(page).toHaveURL(swiped);
});

/**
 * The crop tool under a finger, which is a different question from under a mouse.
 *
 * Three things a pointer test cannot ask. A grip has to be big enough to hit, and to be what a
 * finger actually lands on - the edit panel is a sheet across the foot of the window and the
 * grips a crop needs most are on the picture's bottom edge. The browser must not take the drag
 * for a scroll or a pinch, which is `touch-action`. And the stage's own one-finger pan is the
 * *same gesture* as dragging the rectangle, so it has to do nothing while the tool is open or
 * the photograph slides out from under a rectangle laid out for a fitted view.
 */
test('the crop rectangle takes a finger, and the stage does not pan under it', async ({ page }) => {
  const photoId = await firstPhotoId(page, PHONE_PHOTOS_DIR);
  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await waitForEditorLive(page);

  await editTools(page).getByRole('radio', { name: 'Crop' }).click();
  await expect.poll(async () => cropRect(page)).not.toBeNull();
  const was = await cropRect(page);
  if (was == null) throw new Error('the crop has no rectangle');
  // The corner grip hangs inside the rectangle's bottom right, and says so with its cursor.
  const box = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    if (hit == null || getComputedStyle(hit).cursor !== 'nwse-resize') return null;
    const { left, top, width, height } = hit.getBoundingClientRect();
    return { x: left, y: top, width, height };
  }, { x: was.x + was.width - 8, y: was.y + was.height - 8 });
  if (box == null) throw new Error('the crop has no grip');
  // The target, not the mark: 44px is the smallest thing a finger reliably lands on.
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);

  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Nothing over it: the edit panel is a sheet across the foot of the window, and the grips a
  // crop needs most are on the picture's bottom edge, under exactly that.
  const at = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit == null ? 'nothing' : getComputedStyle(hit).cursor;
  }, from);
  expect(at, `something covers the grip at ${from.x},${from.y}`).toBe('nwse-resize');
  await swipe(page, from, -120);

  // The rectangle moved, which is only true if the touch reached the grip rather than being
  // swallowed as a scroll.
  await expect
    .poll(async () => {
      const now = await cropRect(page);
      return now == null ? false : Math.abs(now.width - was.width) > 20;
    }, { timeout: 15_000 })
    .toBe(true);

  // And the photograph did not move under it. A drag outside the rectangle is the stage's own
  // pan gesture, which is the *same* one-finger drag the rectangle wants, so it has to do
  // nothing while the tool is open - and the picture itself is what says so.
  const still = await settledPicture(page);
  // In the shade the drag above just made, which is outside the rectangle by construction: an
  // untouched photograph's rectangle was the whole picture.
  await swipe(page, { x: was.x + was.width / 2, y: was.y + was.height - 4 }, -120);
  await page.waitForTimeout(500);
  expect((await pictureAlone(page)).equals(still), 'the picture moved under the drag').toBe(true);

  await editTools(page).getByRole('radio', { name: 'Cursor' }).click();
});

/** The crop rectangle as a finger finds it: what offers to move the picture's middle, if anything. */
async function cropRect(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const stage = await photoStage(page).boundingBox();
  if (stage == null) return null;
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    if (hit == null || getComputedStyle(hit).cursor !== 'move') return null;
    const { left, top, width, height } = hit.getBoundingClientRect();
    return { x: left, y: top, width, height };
  }, { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 });
}

// The editor's picture once it has stopped changing: a redraw lands a frame or two after
// whatever asked for it.
async function settledPicture(page: Page): Promise<Buffer> {
  let last = await pictureAlone(page);
  for (;;) {
    await page.waitForTimeout(250);
    const now = await pictureAlone(page);
    if (now.equals(last)) return now;
    last = now;
  }
}

// The photograph without the crop drawn over it: the rectangle moving is the point of the drag.
const PICTURE_ONLY = `
  [role="region"][aria-label="Photo"] * { visibility: hidden !important; }
  [role="region"][aria-label="Photo"] canvas[role="img"] { visibility: visible !important; }
`;

function pictureAlone(page: Page): Promise<Buffer> {
  return editPreview(page).screenshot({ style: PICTURE_ONLY });
}

// Every control a gesture replaces is out of the bar: the frame is dragged aside to
// step, tapped to step the zoom and pinched for the scales between. What is left keeps
// to one line, its menus folded into an overflow button.
test('the bar keeps to one line, without the controls a finger makes redundant', async ({ page }) => {
  await openFirstPhoto(page);

  const nav = photoControls(page);
  const control = await nav.getByRole('button').first().boundingBox();
  const bar = await nav.boundingBox();
  if (control == null || bar == null) throw new Error('the header has no box');
  expect(bar.height).toBeLessThan(control.height * 2);

  await expect(nav.getByRole('button', { name: 'Download' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'More' }).click();
  // Every menu the viewer has, in the one popup - the same one a wide window gets.
  await expect(page.getByRole('menuitem', { name: 'Update photo details' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Download original' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Fullscreen' })).toBeVisible();
  // Out of the middle of a long popup: the one item that destroys something sits
  // at the foot of it, not a row above the next section's ordinary actions.
  await expect(page.getByRole('menuitem').last()).toHaveText('Move to Bin');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem')).toHaveCount(0);

  await expect(nav.getByRole('button', { name: 'Next photo' })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: 'Previous photo' })).toHaveCount(0);
  // The readout stays: it is the only thing that says whether this is 1:1.
  await expect(nav.getByText(/^\d+%$/)).toBeVisible();

  const box = await photoStage(page).boundingBox();
  if (box == null) throw new Error('the stage has no box');
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await pinch(page, middle, 80, 320);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'grab');
  // And a pinch is not a swipe: the photograph on screen is the one that was
  // pinched, however far the two fingers travelled.
  const url = page.url();
  await pinch(page, middle, 320, 80);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'zoom-in');
  expect(page.url()).toBe(url);

  // And the sidebar, which a swipe reaches anywhere else, has a button in the bar too.
  await expect(drawer(page)).not.toBeVisible();
  await nav.getByRole('button', { name: 'Show sidebar' }).tap();
  await expect(drawer(page)).toBeVisible();
});

test('the verdict is on a bar at the foot of the window, with the rest under it', async ({ page }) => {
  await openFirstPhoto(page);

  const details = sheet(page);
  await expect(details.getByRole('button', { name: 'Pick' })).toBeVisible();
  // Under the fold until asked for: the stars, and every panel of metadata.
  await expect(details.getByRole('button', { name: 'Set rating to 3' })).toHaveCount(0);
  await expect(details.getByRole('group', { name: PANELS })).toHaveCount(0);

  const bar = await details.boundingBox();
  const window = page.viewportSize();
  if (bar == null || window == null) throw new Error('the sheet has no box');
  expect(Math.round(bar.y + bar.height)).toBe(window.height);

  await details.getByRole('button', { name: 'Show metadata' }).click();
  await expect(details.getByRole('button', { name: 'Set rating to 3' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Pick' })).toBeVisible();

  await details.getByRole('button', { name: 'Hide metadata' }).click();
  await expect(details.getByRole('group', { name: PANELS })).toHaveCount(0);
});

// The one way to reach a photograph that is not the next one: swiping is a frame
// at a time, so without this a phone cannot cross a collection at all.
test('the filmstrip opens from the sheet, along the foot and above the verdict', async ({ page }) => {
  await openFirstPhoto(page);
  const details = sheet(page);
  await expect(gallery(page)).toHaveCount(0);

  const stage = photoStage(page);
  const before = await stage.boundingBox();
  await details.getByRole('button', { name: 'Show filmstrip' }).click();
  const strip = gallery(page);
  await expect(strip).toHaveCSS('overflow-x', 'auto');
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  const box = await strip.boundingBox();
  const verdict = await details.getByLabel('Triage').boundingBox();
  const after = await stage.boundingBox();
  if (box == null || verdict == null || before == null || after == null) throw new Error('the sheet has no box');
  expect(box.y + box.height).toBeLessThanOrEqual(Math.round(verdict.y) + 1);
  // Layout, not an overlay: the photograph gives up exactly the height the strip took.
  expect(after.height).toBeLessThanOrEqual(before.height - box.height);
  expect(after.width).toBeLessThanOrEqual(before.width);
  expect(after.y + after.height).toBeLessThanOrEqual(Math.round(box.y) + 1);

  // A drag along the strip scrolls the strip. Anywhere else on the page a
  // rightward drag pulls the sidebar out, so the strip has to be exempt or the one
  // gesture that crosses a collection opens the drawer over it instead.
  await swipe(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 160);
  await expect(drawer(page)).not.toBeVisible();

  // Narrow enough that the cells no longer fit, which is the strip's ordinary
  // state: a column that took its width from what the strip is scrolling put the
  // stage a whole sidebar off the side of the window.
  await page.setViewportSize({ width: 240, height: 844 });
  const narrow = await stage.boundingBox();
  if (narrow == null) throw new Error('the stage has no box');
  expect(narrow.width).toBeLessThanOrEqual(240);

  await details.getByRole('button', { name: 'Hide filmstrip' }).click();
  await expect(gallery(page)).toHaveCount(0);
});

// The only way to size the strip here: the edge is dragged, and a finger has to be
// able to find it and hold it without a scroller taking the gesture first.
test('the filmstrip is made thicker by dragging its edge with a finger', async ({ page }) => {
  await openFirstPhoto(page);
  await sheet(page).getByRole('button', { name: 'Show filmstrip' }).click();
  const strip = gallery(page);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  const handle = page.getByRole('separator', { name: 'Resize filmstrip' });
  const grab = await handle.boundingBox();
  const before = await strip.boundingBox();
  if (grab == null || before == null) throw new Error('the strip has no box');
  // Its gutter and the whole of the gap it may overhang into, which is all there is to give: the
  // 44px a tap target gets elsewhere here would be a band across the photographs or the stage.
  expect(grab.height).toBeGreaterThanOrEqual(14);

  // Up the screen, the strip being under the photograph: a drag towards it is more of it.
  await swipe(page, { x: grab.x + grab.width / 2, y: grab.y + grab.height / 2 }, 0, -60);
  await expect
    .poll(async () => (await strip.boundingBox())?.height ?? 0)
    .toBeGreaterThan(before.height + 40);
  // The handle is not the strip, so it is not exempt from the drawer's own gesture: what keeps
  // the sidebar shut through this is that the drag is up the screen rather than across it.
  await expect(drawer(page)).not.toBeVisible();
});

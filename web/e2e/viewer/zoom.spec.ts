// Magnifying a photograph: the stops a click walks, the slider in the menu, the
// pan limits, and what survives a rendition change or a stage that changed shape.
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHOTO_NAMES, ZOOM_PHOTOS_DIR } from '../fixture_library';
import {
  FIRST_FRAME,
  gotoPhoto,
  photoStage,
  setHideSidebarInViewer,
  setRenditionSource,
  setViewerRendition,
  shownFilename,
  shownFrame,
  stepZoom,
  useLibrary,
} from '../helpers';

// In order: one of these re-points the library at a render, which the rest do not
// care about but would pay a decode for.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, ZOOM_PHOTOS_DIR);
});

test.beforeEach(async ({ request }) => {
  // The sidebar stays: a portrait frame at its own pixels overhangs sideways in a stage
  // the window less 208px wide, and not in one with the sidebar's width back, which
  // leaves the pan limit below at zero and nothing to clamp.
  await setHideSidebarInViewer(request, false);
});

// The stage draws this into a slot inside a popup that exists only while the menu is
// open, which is the part no unit test can stand in for: the track's ends and what Fit
// does are `zoom_slider.test.tsx`, and Base UI's slider takes no drag headlessly anyway.
test('the photo fits the stage, clicks step fit, double, own pixels, and the menu range follows', async ({ page }) => {
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible(FIRST_FRAME);

  // Regression: as a grid item the image grew the row to its own height, so
  // `height: 100%` resolved against that and tall frames were cropped.
  const fits = await shownFrame(page).evaluate((frame) => {
    const vp = frame.closest('[role="region"]');
    if (vp == null) return false;
    return frame.getBoundingClientRect().height <= vp.clientHeight + 1;
  });
  expect(fits).toBe(true);

  const open = (): Promise<void> => page.getByRole('button', { name: 'More' }).click();
  const track = page.getByRole('slider', { name: 'Zoom' });

  // The bar keeps the readout and gives up the control: one line has to hold the way
  // out, the verdict and the menu.
  await expect(readout(page)).toBeVisible();
  await expect(photoControls(page).getByRole('button', { name: /^Zoom/ })).toHaveCount(0);

  await open();
  await expect(page.getByRole('group').filter({ has: track }).last()).toBeVisible();
  const fitted = await track.inputValue();
  await page.keyboard.press('Escape');

  // A click on the picture is the same zoom the slider is over, so the popup opened
  // after one shows where the stage got to rather than where it started.
  await stepZoom(page);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'grab');
  await open();
  expect(Number(await track.inputValue())).toBeGreaterThan(Number(fitted));

  await page.getByRole('button', { name: 'Fit' }).click();
  await expect(shownFrame(page)).toHaveCSS('cursor', 'zoom-in');
  await page.keyboard.press('Escape');

  // Against the frame's own pixels: a 24MP render fitted to a stage a few hundred
  // pixels tall is nowhere near 1:1.
  await expect(readout(page)).not.toHaveText('100%');

  // Twice fitted, then the frame's own pixels - which has to be reachable however
  // large the render is, that being the magnification a cull judges one at.
  await stepZoom(page);
  await stepZoom(page);
  await expect(readout(page)).toHaveText('100%');

  await stepZoom(page);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'zoom-in');
});

function photoControls(page: Page): Locator {
  return page.getByRole('group', { name: 'Photo controls' });
}

// The magnification, in the bar with the rest of the controls.
function readout(page: Page): Locator {
  return photoControls(page).getByText(/^\d+%$/);
}

test('clicking zooms into the point clicked, not the centre', async ({ page }) => {
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible(FIRST_FRAME);

  // Regression: the zoom-about-point maths ran inside a setScale updater and
  // called setOffset from within it. React re-invokes updaters, so the offset was
  // applied about twice and the clicked detail slid away from the cursor.
  const drift = await shownFrame(page).evaluate(async (frame: HTMLCanvasElement) => {
    const vp = frame.closest('[role="region"]');
    if (vp == null) return null;
    // The zoom is on the picture, which is what holds the renditions of a photograph.
    const drawn = frame.parentElement as HTMLElement;
    const box = vp.getBoundingClientRect();
    // A canvas's own width and height are its intrinsic size, which is what the layout fits.
    const fit = Math.min(box.width / frame.width, box.height / frame.height);
    const read = (): { x: number; y: number; s: number } => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(drawn.style.transform);
      return m == null ? { x: 0, y: 0, s: 1 } : { x: +m[1]!, y: +m[2]!, s: +m[3]! };
    };
    // Which point of the photo sits under a screen coordinate, 0..1.
    const fraction = (px: number, py: number): { x: number; y: number } => {
      const t = read();
      const w = frame.width * fit * t.s;
      const h = frame.height * fit * t.s;
      return {
        x: (px - (box.left + box.width / 2 + t.x - w / 2)) / w,
        y: (py - (box.top + box.height / 2 + t.y - h / 2)) / h,
      };
    };
    // Off-centre but well inside the pan limits, so the clamp cannot mask this.
    const px = box.left + box.width * 0.5;
    const py = box.top + box.height * 0.62;
    const before = fraction(px, py);
    frame.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py }));
    await new Promise((r) => setTimeout(r, 200));
    const after = fraction(px, py);
    return { zoomed: read().s > 1, dx: Math.abs(after.x - before.x), dy: Math.abs(after.y - before.y) };
  });

  expect(drift?.zoomed).toBe(true);
  expect(drift?.dx).toBeLessThan(0.01);
  expect(drift?.dy).toBeLessThan(0.01);
});

test('panning a zoomed photo cannot drag it off the stage', async ({ page }) => {
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible(FIRST_FRAME);

  await stepZoom(page);
  const viewport = photoStage(page);
  const box = (await viewport.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Drag far past any legal offset. Unclamped this left the photo detached from
  // the viewport edge, showing empty background where the image should be.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 4000, cy + 4000, { steps: 5 });
  await page.mouse.up();

  const gap = await shownFrame(page).evaluate((frame) => {
    const vp = frame.closest('[role="region"]');
    if (vp == null) return -1;
    const i = frame.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    // How far the image's leading edges sit inside the viewport. A zoomed photo
    // is larger than the stage, so this can never legitimately be positive.
    return Math.max(i.left - v.left, i.top - v.top);
  });
  expect(gap).toBeLessThanOrEqual(1);
  // And it moved at all: the clamp above is satisfied just as well by a drag
  // that did nothing, which is what the regression below actually was.
  const moved = await shownFrame(page).evaluate((frame) => (frame.parentElement as HTMLElement).style.transform);
  expect(moved).not.toContain('translate(0px, 0px)');
});

test('zoom resets on a step to the next photo, which is a different photograph', async ({ page }) => {
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  const opened = await shownFilename(page);

  await stepZoom(page);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'grab');

  // Carrying the offset across would open the next frame scrolled into a corner.
  await page.getByRole('button', { name: 'Next photo' }).click();
  const next = PHOTO_NAMES.find((name) => name !== opened);
  await expect(shownFrame(page)).toHaveAccessibleName(new RegExp(`^${next}, `), { timeout: 60_000 });
  await expect(shownFrame(page)).toHaveCSS('cursor', 'zoom-in');
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
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  // What the transform is, and what it is allowed to be, measured from the page rather than
  // assumed: the limit depends on the frame's shape and the box it is fitted into.
  const state = async (): Promise<{ x: number; limit: number }> => {
    return shownFrame(page).evaluate((frame: HTMLCanvasElement) => {
      const viewport = frame.closest('[role="region"]') as HTMLElement;
      // The zoom is on the picture the frame is drawn in, not on the frame.
      const transform = new DOMMatrixReadOnly(getComputedStyle(frame.parentElement as HTMLElement).transform);
      const box = viewport.getBoundingClientRect();
      const fit = Math.min(box.width / frame.width, box.height / frame.height);
      const content = frame.width * fit * transform.a;
      return { x: transform.e, limit: Math.max(0, (content - box.width) / 2) };
    });
  };

  // All the way to the frame's own pixels, not just the double stop: this photograph is
  // portrait in a landscape stage, so at 2x it still does not overhang horizontally and
  // there is no sideways pan to be left out of range.
  await stepZoom(page);
  await stepZoom(page);
  await expect(shownFrame(page)).toHaveCSS('cursor', 'grab');

  // Panned hard against one edge, so the offset is exactly the limit and any shrinking of
  // that limit leaves it outside.
  const box = (await photoStage(page).boundingBox())!;
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

// The stage's view state is keyed on the photo, never on the file being shown.
// Stack triage's flip mode is built entirely on this (§20.4): it holds two
// frames of one round under a single photoKey, so that alternating between them
// keeps the zoom and pan the photographer set up. This pins the property from
// the viewer's side, where it is also what makes "compare this render against the
// camera's JPEG" a comparison rather than a reset.
//
// Last with the one after it, because they are the tests here that need the library to render.
test('zoom survives a rendition change, so two files can be compared at the same magnification', async ({ page }) => {
  await setRenditionSource(page, ZOOM_PHOTOS_DIR, 'render');
  await setViewerRendition(page.request, 'full');
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  const scale = (): Promise<number> =>
    shownFrame(page).evaluate((frame) => {
      const match = /scale\(([\d.]+)\)/.exec((frame.parentElement as HTMLElement).style.transform);
      return match == null ? 1 : Number(match[1]);
    });

  await stepZoom(page);
  expect(await scale()).toBeGreaterThan(1);
  const before = await scale();

  // A different file for the same photograph: photoKey does not move, so nothing
  // about the view should.
  await page.keyboard.press('i');
  await expect(shownFrame(page)).toHaveAccessibleName(/Embedded JPEG$/, { timeout: 60_000 });
  expect(await scale()).toBe(before);
});

// The browser's AVIF decoder ignores the size it is asked for, so the frame the stage holds for
// a native-resolution render is already every pixel of it - which only a real decoder can say.
test('at its own pixels, a render flipped back to is drawn sharp from the frame already held', async ({ page }) => {
  // The max-quality render is built on the way in, and the 60s default expires mid-build.
  test.setTimeout(240_000);
  await setViewerRendition(page.request, 'max');
  await gotoPhoto(page, ZOOM_PHOTOS_DIR);
  await expect(shownFrame(page)).toHaveAccessibleName(/\(max quality\)$/, { timeout: 120_000 });

  await stepZoom(page);
  await stepZoom(page);
  await expect(readout(page)).toHaveText('100%');
  // The detail canvas is the one frame on the stage that is not a picture of its own.
  const sharp = photoStage(page).locator('canvas:not([role])[style*="opacity: 1"]');
  await expect(sharp).toHaveCount(1, { timeout: 30_000 });

  await page.keyboard.press('o');
  await expect(shownFrame(page)).toHaveAccessibleName(/Rendered RAW$/, { timeout: 60_000 });

  const fetched: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(route(PathSegment.renditions(), 'max'))) fetched.push(request.url());
  });
  // Every frame from the key to the detail, counting the ones that show the render magnified
  // from its fitted frame instead.
  const soft = page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        let frames = 0;
        const started = performance.now();
        const tick = (): void => {
          const stage = document.querySelector('[role="region"][aria-label="Photo"]');
          const shown = [...(stage?.querySelectorAll('[role="img"]') ?? [])].find(
            (frame) => frame.closest('[aria-hidden="true"]') == null && frame.getAttribute('aria-label')?.endsWith('(max quality)'),
          );
          const detailed = [...(stage?.querySelectorAll<HTMLElement>('canvas:not([role])') ?? [])].some(
            (detail) => detail.style.opacity === '1',
          );
          if (shown != null && detailed) return resolve(frames);
          if (shown != null) frames++;
          if (performance.now() - started > 30_000) return reject(new Error('the render never sharpened'));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await page.keyboard.press('p');
  expect(await soft).toBe(0);
  expect(fetched).toEqual([]);
});

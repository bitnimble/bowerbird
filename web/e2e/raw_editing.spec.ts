import { type Page, expect, test } from '@playwright/test';
import { EDIT_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, openPhoto, openPhotoId, syncLibrary, waitForSyncSettled } from './helpers';

// Every test here opens a RAW for real: the server decodes it, fits the camera match and
// warps it, and the browser grades it on a GPU. The open is seconds of native work behind
// however many cores the rest of the suite has left.
test.describe.configure({ timeout: 180_000 });

// The editor opens a photo by id, so a spec needs a synced library before it can open
// anything. Done once and the id reused, because a sync is a real decode of a real ARW.
let photoId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await addLibrary(page, EDIT_PHOTOS_DIR);
  await syncLibrary(page, EDIT_PHOTOS_DIR);
  await waitForSyncSettled(page, EDIT_PHOTOS_DIR, PHOTO_NAMES.length);
  await openLibrary(page, EDIT_PHOTOS_DIR);
  await openPhoto(page);
  photoId = openPhotoId(page);
  await page.close();
});

/**
 * The tick runs on a GPU, and nothing else in the suite can see that it did.
 *
 * Without this the editor could be reporting `live` off a canvas nobody ever drew into,
 * which looks exactly like a frame that graded to black. The adapter is the one piece of
 * evidence that a device was acquired rather than silently skipped.
 */
test('grades on the GPU, into a stage sized for the viewport', async ({ page }) => {
  await open(page);

  await expect(page.getByTestId('raw-edit-adapter')).not.toHaveText('');
  const size = await page.getByTestId('raw-edit-size').textContent();
  const [width, height] = (size ?? '0x0').split('x').map(Number);
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(1000);

  // The canvas is the viewport in device pixels and then some, not the frame: the draw
  // runs once per canvas pixel, so a stage the size of a 61MP sensor would be grading
  // fifteen times the pixels any display can show (`docs/raw-edit-gpu.md` §6).
  const canvas = page.locator('canvas.raw-edit__stage');
  await expect(canvas).toHaveCount(1);
  const stage = await canvas.evaluate((el: HTMLCanvasElement) => ({
    w: el.width,
    h: el.height,
    // What it is allowed to be: the box it is laid out in, in device pixels, and the 1.5x
    // supersample on top. Measured here rather than assumed, because the runner's window is
    // not the only size this ever runs at.
    bound: Math.ceil(
      Math.max(el.clientWidth, el.clientHeight) * (globalThis.devicePixelRatio || 1) * 1.5,
    ),
  }));
  expect(stage.w).toBeGreaterThan(0);
  // Against the viewport, not against the frame. `<= width` was the frame's own size, which
  // is the one number that cannot fail: a stage sized to a 61MP sensor - the thing this
  // exists to catch - satisfies it exactly.
  expect(stage.w).toBeLessThanOrEqual(stage.bound + 1);
  expect(stage.h).toBeLessThanOrEqual(stage.bound + 1);
  expect(stage.w).toBeLessThanOrEqual(width);
  expect(stage.h).toBeLessThanOrEqual(height);
  // And it keeps the frame's shape, or `object-fit: contain` would show it stretched.
  expect(stage.w / stage.h).toBeCloseTo(width / height, 1);
});

/**
 * The camera match has to reach the client, and no other check can see that it did:
 * without it the grade takes its neutral arm and still produces a plausible HDR frame at
 * the right size, just flatter and less saturated than the rendition of the same file.
 *
 * It has been wrong twice before, both times numerically rather than structurally, and
 * both times silently (DESIGN 21.1). The fit runs natively now, so what this guards is the
 * hand-off: the curves, the matrix and the chroma lattice crossing as arrays a shader can
 * index, rather than being dropped somewhere in the header.
 */
test('grades through the camera match, as the renditions do', async ({ page }) => {
  await open(page);

  await expect(page.getByTestId('raw-edit-panel')).toHaveAttribute('data-matched', 'true');
});

/**
 * A failure the user can act on, which is worth a test because the failure mode is silent
 * plausibility: the API's envelope nests its message under `error`, so a caller that
 * stringifies one level too high reports "[object Object]" for every kind of failure alike
 * and the page still looks like it is working.
 */
test('says why an id it cannot open failed', async ({ page }) => {
  const missing = '00000000-0000-0000-0000-000000000000';
  // `?edit` skips the viewer's empty state so the editor's own open path is what fails.
  await page.goto(`/photos/${missing}?edit=1`);

  const panel = page.getByTestId('raw-edit-panel');
  await expect(panel).toHaveAttribute('data-status', 'failed');
  await expect(panel).toContainText(missing);
  await expect(panel).not.toContainText('[object Object]');
});

/**
 * Moving the slider has to change the picture, which is the one thing a parity fixture
 * cannot check: it pins what the shaders compute, not that a slider is wired to them.
 *
 * Read off the canvas rather than off a status field, because "the exposure changed" and
 * "a frame was drawn with it" are different claims and only the second one matters.
 */
test('a slider move redraws the canvas', async ({ page }) => {
  await open(page);

  const canvas = page.locator('canvas.raw-edit__stage');
  const before = await canvas.screenshot();

  // The thumb rather than the control: Base UI's slider carries the value on a hidden
  // range input inside it, and the labelled element is the track around it.
  const thumb = page.locator('.raw-edit-panel__exposure input[type="range"]');
  await thumb.focus();
  // Keyboard rather than filling the input: setting the DOM value directly skips the
  // events the component listens for, so the picture would never be asked to change.
  // How far one press moves is the component's business, so assert that it moved.
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');

  // Not `+0.00 EV`, which was here and could not fail: the panel writes the sign only above
  // zero, so at rest it reads `Exposure 0.00 EV` and the negated match held before the
  // keypresses as well as after. `0.00 EV` is the reading that has to stop being true.
  await expect(page.locator('.raw-edit-panel__exposure')).not.toContainText('0.00 EV');
  await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 30_000 }).toBe(false);
});

/**
 * The fixture open and graded.
 *
 * Waiting on `live`, which the presenter sets only once the prepared frame has arrived and
 * the pipeline exists. The first draw is submitted immediately after.
 */
async function open(page: Page): Promise<void> {
  await page.goto(`/photos/${photoId}?edit=1`);

  const panel = page.getByTestId('raw-edit-panel');
  await expect
    .poll(async () => panel.getAttribute('data-status'), { timeout: 170_000 })
    .toBe('live');
}

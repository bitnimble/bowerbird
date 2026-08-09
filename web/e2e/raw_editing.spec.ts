import { type Page, expect, test } from '@playwright/test';
import { EDIT_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, openPhoto, openPhotoId, syncLibrary, waitForSyncSettled } from './helpers';

// Every test here opens a RAW for real: the server decodes it, fits the camera match and
// warps it, and the browser grades it on a GPU. The open is seconds of native work behind
// however many cores the rest of the suite has left.
//
// **This is the only test that spans the whole path, and that is what it is for.** Four
// things check the GPU and they fail at different places:
//
//   gpu_shader.rs      the WGSL arithmetic against `hdr_fit`, in `cargo test`, ~40ms
//   gpu_fixture.rs     that `fixtures/gpu/*.expected.bin` is still what the CPU produces
//   gpu_parity.spec    that the shaders reproduce those bytes, from a fixture payload
//   this file          that a real photo reaches a real device and comes back `live`
//
// The first three all build their payload in-process. This one gets it from the running
// server, which `dlopen`s `librawshim.so` - so it is the only one that can see the native
// library and the client disagreeing. That has happened: the lattice grew a fifth value
// per node, `cargo test` rebuilt the test binaries but not the cdylib, and the server
// served four-value nodes to a client reading five. Every other suite stayed green; this
// one reported `failed` instead of `live`. `test:e2e` now builds the native library first,
// and the client checks the node count rather than trusting a field, but the reason this
// test cannot move into `cargo test` is that a Rust harness links the crate directly and
// would have been green through all of it.
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
 * The same zoom the viewer has, on a surface that cannot be transformed.
 *
 * The viewer scales an `<img>` and the browser does the rest; a canvas has nothing to scale,
 * so the gesture has to come out the other side as a *region* and the frame be redrawn at
 * it. That conversion is the whole of what is new here - the gesture itself is the viewer's
 * code (`zoom_pan.ts`) - and it is the part that can be silently wrong: a region that never
 * moves looks exactly like a zoom that works, because the canvas is upscaled by CSS either
 * way and the picture does get bigger.
 */
test('zooms and pans the frame the viewer’s way, into a region', async ({ page }) => {
  await open(page);

  const region = page.getByTestId('raw-edit-region');
  const size = await page.getByTestId('raw-edit-size').textContent();
  const [width, height] = (size ?? '0x0').split('x').map(Number);

  // Fitted: the whole frame, which is what an open shows.
  await expect(region).toHaveText(`0,0 ${width}x${height}`);

  const read = async (): Promise<{ x: number; y: number; w: number; h: number }> => {
    const text = (await region.textContent()) ?? '';
    const [at, extent] = text.split(' ');
    const [x, y] = (at ?? '').split(',').map(Number);
    const [w, h] = (extent ?? '').split('x').map(Number);
    return { x: x ?? 0, y: y ?? 0, w: w ?? 0, h: h ?? 0 };
  };

  // A click zooms to the next stop about the point clicked, so the region shrinks and sits
  // around it rather than around the middle.
  const viewport = page.locator('.raw-edit-stage .stage__viewport');
  const box = (await viewport.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.25);

  await expect.poll(async () => (await read()).w).toBeLessThan(width);
  const zoomed = await read();
  expect(zoomed.h).toBeLessThan(height);
  // Up and to the left of centre, because that is where the pointer was.
  expect(zoomed.x).toBeLessThan((width - zoomed.w) / 2);
  expect(zoomed.y).toBeLessThan((height - zoomed.h) / 2);
  // And still inside the frame.
  expect(zoomed.x).toBeGreaterThanOrEqual(0);
  expect(zoomed.y).toBeGreaterThanOrEqual(0);
  expect(zoomed.x + zoomed.w).toBeLessThanOrEqual(width + 1);

  // Dragging pans. Leftwards, because zooming about the top-left corner has already put the
  // window against the frame's left edge and the clamp holds it there - the room to move is
  // to the right, and the picture goes the other way to the pointer.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await read()).x).toBeGreaterThan(zoomed.x);
  const panned = await read();
  // A pan moves the window, it does not resize it.
  expect(panned.w).toBe(zoomed.w);
  expect(panned.h).toBe(zoomed.h);
  // And never off the frame.
  expect(panned.x + panned.w).toBeLessThanOrEqual(width + 1);

  // The viewer's zoom control, in the viewer's slot, climbing the viewer's ladder: fitted,
  // twice that, the frame's own pixels, and round to fitted again. Two presses from here,
  // because 1:1 on a 4024px frame in a stage this size is a stop of its own.
  await expect(page.getByText(/^\d+%$/)).toBeVisible();
  // By role rather than by one of its labels: the button says what the *next* stop is, so
  // its name changes as the ladder is climbed - "Zoom to 100%" here, "Zoom out to fit" at
  // the top.
  const zoomButton = page.getByRole('button', { name: /^Zoom/ });
  await zoomButton.click();
  await expect.poll(async () => (await read()).w).toBeLessThan(panned.w);
  // At the top it turns around, which is how the reader gets back without a gesture.
  await expect(zoomButton).toHaveAccessibleName('Zoom out to fit');
  await zoomButton.click();
  await expect.poll(async () => (await read()).w).toBe(width);
  await expect(region).toHaveText(`0,0 ${width}x${height}`);
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
 * And a presence slider, which is the one group the parity fixtures are structurally blind to.
 *
 * Those pin the grade at every slider zero, and `adjusted` returns early there without ever
 * sampling `detail.wgsl`'s blur - so a texture that was never allocated, never dispatched into,
 * or bound at the wrong entry would leave every fixture green and every parity byte identical.
 * The band arithmetic is measured in `gpu_fixture.rs` against a constructed frame; what only
 * the browser can say is whether the three passes ran here at all.
 */
test('a presence slider redraws the canvas, which is what says the blur was built', async ({ page }) => {
  await open(page);

  const canvas = page.locator('canvas.raw-edit__stage');
  const before = await canvas.screenshot();

  const thumb = page.locator('[data-testid="raw-edit-clarity"] input[type="range"]');
  await thumb.focus();
  await page.keyboard.press('End');

  await expect(page.locator('[data-testid="raw-edit-clarity"]')).toContainText('Clarity +100');
  await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 30_000 }).toBe(false);
});

/**
 * The white balance pair, which is the one control whose slider position is not what the
 * document holds.
 *
 * At rest it shows the frame's own illuminant and the document says nothing, so what this
 * checks is the seam between the two: the header carried a camera neutral at all, the slider
 * took its position from it, and the first move turned that position into a stored number and
 * a redrawn frame. A header without `asShot` leaves the sliders absent entirely, so the
 * locator failing is itself the report.
 */
test('the white balance pair starts where the camera metered and moves from there', async ({ page }) => {
  await open(page);

  const temperature = page.locator('[data-testid="raw-edit-temperature"]');
  await expect(temperature).toContainText('K');
  const before = await temperature.textContent();

  const canvas = page.locator('canvas.raw-edit__stage');
  const drawn = await canvas.screenshot();

  await temperature.locator('input[type="range"]').focus();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');

  await expect(temperature).not.toHaveText(before ?? '');
  // "Custom" rather than the mode the document arrived with, which is what says the pair is
  // now stored rather than still standing in for the camera's.
  await expect(page.locator('[data-testid="raw-edit-white-balance"]')).toContainText('Custom');
  await expect.poll(async () => (await canvas.screenshot()).equals(drawn), { timeout: 30_000 }).toBe(false);
});

/**
 * An edit has to survive the page, which is the whole point of storing one.
 *
 * End to end rather than in a unit test: the value crosses the presenter, the client, four
 * routes, two tables and back, and every one of those has already been the thing that was
 * wrong. What a repository test cannot see is whether the reload asks for the edits at all.
 *
 * The revision is asserted alongside the value because they fail differently: a save that
 * never happened leaves the exposure at zero, and a save the server refused leaves the
 * exposure right and the revision at nothing.
 */
test('an exposure survives a reload, and the undo that follows it', async ({ page }) => {
  await open(page);

  const thumb = page.locator('.raw-edit-panel__exposure input[type="range"]');
  await thumb.focus();
  await page.keyboard.press('PageUp');
  await page.keyboard.press('PageUp');

  const exposure = page.locator('.raw-edit-panel__exposure');
  const moved = await exposure.textContent();
  expect(moved).not.toContain('0.00 EV');
  // The commit is on release, so the revision moving is what says the drag reached the
  // server rather than only the shader.
  await expect.poll(async () => page.getByTestId('raw-edit-rev').textContent(), { timeout: 30_000 }).not.toBe('0');

  await open(page);
  await expect(exposure).toHaveText(moved ?? '');
  await expect(page.getByTestId('raw-edit-undo')).toBeEnabled();

  // And the history came back with it: undo is what proves the deltas were stored, not
  // just the document.
  await page.getByTestId('raw-edit-undo').click();
  await expect(exposure).toContainText('0.00 EV');
  await expect(page.getByTestId('raw-edit-redo')).toBeEnabled();
});

/**
 * Leaving the editor has to mean leaving it, including on the way back.
 *
 * Editing was remembered as the photo it had been opened for. Stepping to the next
 * photograph stopped it matching, which reads as closed - but the flag was still set, so
 * stepping back matched again and re-entered the editor nobody had asked for, on a page that
 * had no triage or rating controls while it was there, and paid another full-sensor decode
 * for the privilege. It is read off `?edit` now, which a step drops on its own.
 *
 * Stepped away while still editing, with no Escape first. Escape clears the flag, so a
 * version of this that pressed it went green against the bug it was written for: what has to
 * be walked away from is an editor that is still open.
 */
test('stepping away from the editor and back does not reopen it', async ({ page }) => {
  await open(page);

  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => new URL(page.url()).pathname).not.toContain(photoId);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => new URL(page.url()).pathname).toContain(photoId);

  // Given a moment to reopen if it were going to: the editor mounts in a layout effect, so
  // a bare assertion here would pass before the frame that would have shown it.
  await page.waitForTimeout(500);
  await expect(page.getByTestId('raw-edit-panel')).toBeHidden();
});

/**
 * Opening and closing the editor leaves the history where it found it.
 *
 * Edit mode is in the address now, so it can put entries there - and a version of this that
 * pushed on the way in and replaced on the way out left a duplicate: the entry Escape wrote
 * was the one already behind it, so the first Back after leaving the editor did nothing. Both
 * replace, so one photograph is one entry however many times the editor is opened on it.
 */
test('opening and closing the editor leaves the history alone', async ({ page }) => {
  await page.goto(`/photos/${photoId}`);
  await expect(page.getByRole('button', { name: 'Actions' })).toBeEnabled();

  // Through the menu the reader uses, because it is `startEdit` that puts anything in the
  // history and `?edit` in the address arrives without having called it.
  const before = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(page.getByTestId('raw-edit-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('raw-edit-panel')).toBeHidden();

  expect(await page.evaluate(() => history.length)).toBe(before);
  // And Back goes somewhere, rather than spending a press on an entry for the same photo.
  await page.goBack();
  await expect.poll(async () => new URL(page.url()).pathname).not.toContain(photoId);
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

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
// Serial and in order: these share one photograph and one server, and they edit it. The
// global config already runs one worker and no parallel files; stated here so the file does not
// depend on that staying true.
test.describe.configure({ timeout: 180_000, mode: 'serial' });

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
 *
 * Opened with a presence slider already set, which costs nothing and covers the one part of the
 * pipeline the fixtures are structurally blind to: they pin the grade at every slider zero, and
 * `adjusted` returns early there without ever sampling `detail.wgsl`'s blur - so a texture never
 * allocated, never dispatched into, or bound at the wrong entry leaves every fixture green. What
 * the *value* does is `raw_edit_presenter.test.ts`; that the passes run at all needs a device.
 */
test('grades on the GPU, into a stage sized for the viewport', async ({ page }) => {
  // Stored rather than dragged: what a value *does* is answered without a browser, so the only
  // reason to set one here is to make the passes run. In a `finally`, because leaking a clarity
  // of 100 into the specs below would be a photograph none of them meant to open.
  await setClarity(page, 100);
  try {
    await gradesOnTheGpu(page);
  } finally {
    await setClarity(page, 0);
  }
});

async function setClarity(page: Page, clarity: number): Promise<void> {
  const was = await page.request.get(`/api/photos/${photoId}/edits`);
  const { rev } = (await was.json()) as { rev: number };
  await page.request.put(`/api/photos/${photoId}/edits`, { data: { doc: { version: 1, clarity }, rev } });
}

async function gradesOnTheGpu(page: Page): Promise<void> {
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
}

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
  const missing = 'nosuchid';
  // `?edit` skips the viewer's empty state so the editor's own open path is what fails.
  await page.goto(`/photos/${missing}?edit=1`);

  const panel = page.getByTestId('raw-edit-panel');
  await expect(panel).toHaveAttribute('data-status', 'failed');
  await expect(panel).toContainText(missing);
  await expect(panel).not.toContainText('[object Object]');
});

/**
 * The camera neutral reaches the client, which is the one thing about the white balance no
 * headless test can see: what the sliders *do* with it is `raw_edit_presenter.test.ts`, and
 * what cannot be checked there is that the frame arrived carrying one at all. A header without
 * it leaves the pair absent entirely, so the locator failing is the report.
 */
test('the frame arrives carrying the illuminant the camera metered', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('raw-edit-temperature')).toContainText('K');
});

/**
 * The crop rectangle takes a mouse, which is a claim about a pointer on a real element.
 *
 * Only that. What the resulting fractions *do* - the shape the stage is laid out on, the words
 * the shader is handed - is `raw_edit_presenter.test.ts`, where the numbers can be read rather
 * than inferred from a canvas. What is left here is the gesture, and the revision moving is what
 * says it reached the document rather than only the rectangle.
 */
test('the crop rectangle takes a drag, and the drag reaches the document', async ({ page }) => {
  await open(page);
  const revision = page.getByTestId('raw-edit-rev');
  const wasAt = await revision.textContent();

  await page.getByTestId('raw-edit-crop').click();
  await expect(page.getByTestId('crop-rect')).toBeVisible();
  const box = await page.getByTestId('crop-grip-se').boundingBox();
  if (box == null) throw new Error('the crop has no grip');

  // In from the bottom right, which moves two edges at once.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y - 90, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => revision.textContent(), { timeout: 30_000 }).not.toBe(wasAt);
  // Leaving a mode is choosing another one, so the way out of the crop is the cursor.
  await page.getByTestId('raw-edit-cursor').click();
  await expect(page.getByTestId('crop-rect')).toBeHidden();

  // Put the rectangle back. Left cropped, this photograph reaches the specs below as a
  // different shape from the one they open expecting, and closing the editor queues a
  // rendition rebuild in the middle of the suite.
  await page.getByTestId('raw-edit-undo').click();
  await expect.poll(async () => revision.textContent(), { timeout: 30_000 }).not.toBe(wasAt);
});

/**
 * An edit has to survive the page, which is the whole point of storing one.
 *
 * End to end rather than in a unit test: the value crosses the presenter, the client, four
 * routes, two tables and back, and every one of those has already been the thing that was
 * wrong. What a repository test cannot see is whether the reload asks for the edits at all.
 *
 * The revision is asserted alongside the value because they fail differently: a save that
 * never happened leaves the exposure where it was, and a save the server refused leaves the
 * exposure right and the revision unmoved.
 *
 * **Everything here is relative to where this test found the photograph, and none of it may
 * be an absolute.** The specs above share one photo and one server, and they edit it: by the
 * time this runs the exposure has already been dragged to the top of its range and the history
 * has entries nobody here wrote. Asserting "undo returns to 0.00 EV" passed only while this
 * happened to be the first spec whose saves landed - and then failed by *popping somebody
 * else's delta*, which is a specification of the suite's running order rather than of undo.
 * Downwards for the same reason: a press against the end of the range moves nothing, writes no
 * delta, and would leave every assertion below quietly measuring a photograph this test never
 * touched.
 */
test('an exposure survives a reload, and the undo that follows it', async ({ page }) => {
  await open(page);

  const exposure = page.locator('.raw-edit-panel__exposure');
  const revision = page.getByTestId('raw-edit-rev');
  const started = await exposure.textContent();
  const wasAt = await revision.textContent();

  const thumb = page.locator('.raw-edit-panel__exposure input[type="range"]');
  await thumb.focus();
  // One press, because one settle is one history entry and the undo below steps once.
  await page.keyboard.press('PageDown');

  const moved = await exposure.textContent();
  expect(moved).not.toBe(started);
  // The commit is on release, so the revision moving is what says the drag reached the
  // server rather than only the shader.
  await expect.poll(async () => revision.textContent(), { timeout: 30_000 }).not.toBe(wasAt);

  await open(page);
  await expect(exposure).toHaveText(moved ?? '');
  await expect(page.getByTestId('raw-edit-undo')).toBeEnabled();

  // And the history came back with it: undo is what proves the deltas were stored, not
  // just the document.
  await page.getByTestId('raw-edit-undo').click();
  await expect(exposure).toHaveText(started ?? '');
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
 * A page that opens straight into the editor never shows a viewer frame, so it must not ask
 * the server to make one.
 *
 * The editor is built in a layout effect, so for the render before it the viewer's stage was
 * what stood in the slot. None of it was painted, but its elements had already asked for this
 * photograph's rendition - a full-sensor render on a photo that has none yet - and the same
 * stage warms both neighbours' as soon as a frame of its own decodes. Requests rather than
 * pixels, because nothing about this is visible: the frame it costs is one nobody sees.
 */
test('opening straight into the editor asks for no viewer frames', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    // Every frame but the editor's own, which is served from the same prefix.
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/image/') && !path.endsWith('/prepared')) asked.push(path);
  });

  await open(page);

  expect(asked).toEqual([]);
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
    .poll(
      async () => {
        const status = await panel.getAttribute('data-status');
        // The panel prints why it failed; polling the attribute alone reports only that it
        // did, which on a GPU error is the one thing there is no way to guess.
        if (status === 'failed') {
          throw new Error(await panel.getByTestId('raw-edit-status').innerText());
        }
        return status;
      },
      { timeout: 170_000 },
    )
    .toBe('live');
}

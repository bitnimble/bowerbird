import { type Locator, type Page, expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { EDIT_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import {
  addLibrary,
  editDiagnosticSize,
  editDiagnostics,
  editPreview,
  editTools,
  openLibrary,
  openPhoto,
  openPhotoId,
  photoAction,
  photoStage,
  savedRev,
  scanLibrary,
  waitForEditorLive,
  waitForScanSettled,
} from '../helpers';

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

// Every test here opens a RAW for real: the module decodes it in the tab, fits the camera
// match, warps it and grades it on a GPU. The open is seconds of wasm behind however many
// cores the rest of the suite has left.
//
// **This is the only test that spans the whole path, and that is what it is for.** Three
// things check the GPU and they fail at different places:
//
//   gpu_shader.rs      the WGSL arithmetic against `hdr_fit`, in `cargo test`, ~40ms
//   gpu_fixture.rs     that the grade still draws its snapshots in `test/fixtures/snapshots/`
//   this file          that a real photo reaches a real device and comes back `live`
//
// The first two build their payload in-process, against a Vulkan adapter. This one is the
// module compiled to wasm, on the browser's own adapter, driven by the page - so it is the
// only one that can see the bindings and the page disagreeing.
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
  await scanLibrary(page, EDIT_PHOTOS_DIR);
  await waitForScanSettled(page, EDIT_PHOTOS_DIR, PHOTO_NAMES.length);
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
 * `adjusted` returns early there without ever sampling `detail.slang`'s blur - so a texture never
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
  const was = await page.request.get(route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits()));
  const { rev } = (await was.json()) as { rev: number };
  await page.request.put(route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits()), {
    data: { doc: { version: 1, clarity }, rev },
  });
}

async function gradesOnTheGpu(page: Page): Promise<void> {
  await open(page);

  await expect(editDiagnostics(page)).toHaveAttribute('data-adapter', /./);
  const [width, height] = await editDiagnosticSize(page, 'data-size');
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(1000);

  // The canvas is the viewport in device pixels and then some, not the frame: the draw
  // runs once per canvas pixel, so a stage the size of a 61MP sensor would be grading
  // fifteen times the pixels any display can show (`docs/raw-edit-gpu.md` §6).
  //
  // Off the diagnostics rather than off `el.width`, which is 300x150 for good: the canvas belongs
  // to the worker, and the surface's size is configured there. What is checkable from here is
  // the size the page asked for; that the worker applied it is one call, ordered ahead of the
  // draw on the same message (`local_open.ts`).
  const canvas = editPreview(page);
  await expect(canvas).toHaveCount(1);
  await expect(editDiagnostics(page)).toHaveAttribute('data-stage', /x/);
  const [stageWidth, stageHeight] = await editDiagnosticSize(page, 'data-stage');
  // What it is allowed to be: the box it is laid out in, in device pixels, and the 1.5x
  // supersample on top. Measured here rather than assumed, because the runner's window is
  // not the only size this ever runs at.
  const bound = await canvas.evaluate((el: HTMLCanvasElement) =>
    Math.ceil(Math.max(el.clientWidth, el.clientHeight) * (globalThis.devicePixelRatio || 1) * 1.5),
  );
  expect(stageWidth).toBeGreaterThan(0);
  // Against the viewport, not against the frame. `<= width` was the frame's own size, which
  // is the one number that cannot fail: a stage sized to a 61MP sensor - the thing this
  // exists to catch - satisfies it exactly.
  expect(stageWidth).toBeLessThanOrEqual(bound + 1);
  expect(stageHeight).toBeLessThanOrEqual(bound + 1);
  expect(stageWidth).toBeLessThanOrEqual(width);
  expect(stageHeight).toBeLessThanOrEqual(height);
  // And it keeps the frame's shape, or `object-fit: contain` would show it stretched.
  expect(stageWidth / stageHeight).toBeCloseTo(width / height, 1);
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

  await expect(editDiagnostics(page)).toHaveAttribute('data-matched', 'true');
});

/**
 * The soft proof names its target as a bare string, and this is the only runner that can see
 * whether the module accepts it.
 *
 * `wasm::set_proof` matches `"hdr"` and `"srgb"` and refuses anything else, where the page's
 * `SoftProof` is a TypeScript union the module knows nothing about - so a value renamed on
 * either side compiles, passes `raw_edit_presenter.test.ts` against its recording decoder, and
 * refuses at the first tick. `wasm.rs` is `#[cfg(target_arch = "wasm32")]`, so no cargo suite
 * compiles that match either way.
 *
 * What a proof *does* to the picture is the presenter's test and `job::peak_nits`; what needs a
 * browser is that both names survive the crossing and the tick still draws.
 *
 * A live stage cannot tell the two proofs apart: both names are ones the module accepts, so a
 * label paired with the other one's value refuses nothing and draws the wrong picture in perfect
 * health. That pairing is `raw_edit_panel.test.tsx`'s.
 */
test('both soft proofs cross to the module and keep drawing', async ({ page }) => {
  await open(page);
  const proof = page.getByRole('combobox', { name: 'Soft proof' });

  for (const label of ['sRGB', 'Rec.2020 PQ HDR']) {
    await proof.click();
    await page.getByRole('option', { name: label, exact: true }).click();

    await expect(proof).toHaveText(label);
    // A refused command comes back asynchronously and lands on the tick after it
    // (`gpu::refusal`), so the status is read for a while rather than once.
    await waitForEditorLive(page, 10_000);
    await expect(editDiagnostics(page)).toHaveAttribute('data-adapter', /./);
  }
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
  await page.goto(`${route(PathSegment.photos(), missing)}?edit=1`);

  const details = page.getByRole('region', { name: 'Photo details' });
  await expect(details.getByText(/^Unavailable/)).toBeVisible();
  await expect(details).toContainText(missing);
  await expect(details).not.toContainText('[object Object]');
});

/**
 * The camera neutral reaches the client, which is the one thing about the white balance no
 * headless test can see: what the sliders *do* with it is `raw_edit_presenter.test.ts`, and
 * what cannot be checked there is that the frame arrived carrying one at all. A header without
 * it leaves the pair absent entirely, so the locator failing is the report.
 */
test('the frame arrives carrying the illuminant the camera metered', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('group', { name: 'White balance' }).getByText(/^[\d.]+ K$/)).toBeVisible();
});

function undo(page: Page): Locator {
  return page.getByRole('group', { name: 'Photo controls' }).getByRole('button', { name: 'Undo' });
}

function tool(page: Page, name: 'Cursor' | 'Loupe' | 'Crop' | 'Remove'): Locator {
  return editTools(page).getByRole('radio', { name });
}

/** The pointer the reader is shown over a point of the page. */
async function cursorAt(page: Page, at: Point): Promise<string> {
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit == null ? '' : getComputedStyle(hit).cursor;
  }, at);
}

async function stageBox(page: Page): Promise<Box> {
  const box = await photoStage(page).boundingBox();
  if (box == null) throw new Error('the editor has no stage');
  return box;
}

const middleOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** The crop rectangle as a reader finds it: what offers to move the picture's middle, if anything. */
async function cropRect(page: Page): Promise<Box | null> {
  return page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    if (hit == null || getComputedStyle(hit).cursor !== 'move') return null;
    const { left, top, width, height } = hit.getBoundingClientRect();
    return { x: left, y: top, width, height };
  }, middleOf(await stageBox(page)));
}

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
  const wasAt = await savedRev(page, photoId);

  await tool(page, 'Crop').click();
  await expect.poll(async () => cropRect(page)).not.toBeNull();
  const rect = await cropRect(page);
  if (rect == null) throw new Error('the crop has no rectangle');
  // The corner grip hangs inside the rectangle's bottom right, and says so with its cursor.
  const grip = { x: rect.x + rect.width - 8, y: rect.y + rect.height - 8 };
  expect(await cursorAt(page, grip)).toBe('nwse-resize');

  // In from the bottom right, which moves two edges at once.
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x - 120, grip.y - 90, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => savedRev(page, photoId), { timeout: 30_000 }).not.toBe(wasAt);
  const cropped = await savedRev(page, photoId);
  // Leaving a mode is choosing another one, so the way out of the crop is the cursor.
  await tool(page, 'Cursor').click();
  await expect.poll(async () => cropRect(page)).toBeNull();

  // Put the rectangle back. Left cropped, this photograph reaches the specs below as a
  // different shape from the one they open expecting, and closing the editor queues a
  // rendition rebuild in the middle of the suite.
  await undo(page).click();
  await expect.poll(async () => savedRev(page, photoId), { timeout: 30_000 }).not.toBe(cropped);
});

/**
 * A loop drawn with a real pointer on the stage as the reader has it - zoomed - is searched by the
 * real module, and a fill kept reaches the document.
 *
 * What the search finds is `repair_solve`'s to test, over a field whose answer is known, and what
 * the presenter does with an offer is `raw_edit_presenter.test.ts`. What is left is the gesture on
 * a real overlay, the wheel still zooming under it, and the search on the page's own device through
 * the worker - where a wasm signature out of step with the page is a rejected promise and nothing
 * else.
 */
/**
 * Every colour sample of a thumbnail added up, once it shows: it is copied off a canvas the worker
 * drew on, and one copied too late is a blank image rather than an error.
 */
async function paintedSum(thumbnail: Locator): Promise<number> {
  await expect(thumbnail).toBeVisible({ timeout: 30_000 });
  return thumbnail.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (context == null) return 0;
    context.drawImage(img, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return data.reduce((sum, value, at) => (at % 4 === 3 ? sum : sum + value), 0);
  });
}

/** The bit depth a thumbnail's PNG declares in its header. */
async function bitDepth(thumbnail: Locator): Promise<number> {
  return thumbnail.evaluate(async (img: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    return bytes[24] ?? 0;
  });
}

test('a loop drawn around something is offered fills, and one is kept', async ({ page }) => {
  await open(page);
  const wasAt = await savedRev(page, photoId);
  const stage = photoStage(page);
  const details = page.getByRole('region', { name: 'Photo details' });

  await tool(page, 'Remove').click();
  // The tool's surface covers the stage, and offers to draw.
  const box = await stageBox(page);
  const centre = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 };
  await expect.poll(async () => cursorAt(page, centre)).toBe('crosshair');
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.wheel(0, -300);
  await expect(editPreview(page)).toHaveCSS('cursor', 'grab');
  // A small loop near the middle of the picture, whatever is there.
  const radius = Math.min(box.width, box.height) / 30;
  await page.mouse.move(centre.x + radius, centre.y);
  await page.mouse.down();
  for (let step = 1; step <= 24; step++) {
    const angle = (step / 24) * Math.PI * 2;
    await page.mouse.move(centre.x + radius * Math.cos(angle), centre.y + radius * Math.sin(angle));
  }
  await page.mouse.up();

  const apply = details.getByRole('button', { name: 'Apply', exact: true });
  await expect(apply).toBeVisible({ timeout: 60_000 });
  await expect(details.getByRole('slider', { name: 'Blend' })).toBeVisible();
  // Each fill on offer shows the stage as it would be with that fill chosen.
  const fills = details.getByRole('radiogroup', { name: 'Fills' });
  const firstFill = fills.getByRole('radio', { name: 'Fill 1' }).locator('img');
  expect(await paintedSum(firstFill)).toBeGreaterThan(0);
  // `eightBitPng`: a 16-bit one leaving the page drops the stage to SDR in Chrome on Windows.
  expect(await bitDepth(firstFill)).toBe(8);

  // While it is on offer the stage draws it, where it is read from, and the way between; the fill
  // is taken by the pointer and moved.
  const fill = stage.getByRole('img', { name: 'Fill', exact: true });
  await expect(fill).toHaveCount(1);
  await expect(stage.getByRole('img', { name: 'Fill source' })).toHaveCount(1);
  await expect(stage.getByRole('img', { name: 'From source to fill' })).toHaveAttribute('marker-end', /url\(#/);
  await page.mouse.move(centre.x, centre.y);
  // Zoomed, the stage offers `grab` for a pan as well, so the fill standing out is what says the
  // pointer is on it.
  await expect.poll(async () => cursorAt(page, centre)).toBe('grab');
  await expect(fill).toHaveCSS('stroke-width', '2.5px');
  await page.mouse.down();
  await page.mouse.move(centre.x + radius, centre.y, { steps: 4 });
  await page.mouse.up();
  // Moved, it is one fill: the places found for where it was go with it.
  await expect(fills.getByRole('radio', { name: 'Fill 2' })).toHaveCount(0);
  await expect(fills.getByRole('radio', { name: 'Fill 1' })).toBeVisible();

  // A drag away from both pans the stage, as it would anywhere else, and draws no lasso.
  const before = await fill.getAttribute('points');
  await page.mouse.move(centre.x + radius * 6, centre.y + radius * 6);
  await page.mouse.down();
  await page.mouse.move(centre.x + radius * 9, centre.y + radius * 9, { steps: 6 });
  await page.mouse.up();
  await expect(stage.getByRole('img', { name: 'Loop being drawn' })).toHaveCount(0);
  await expect(fill).not.toHaveAttribute('points', before ?? '');
  await expect(apply).toBeVisible();
  await apply.click();
  await expect.poll(async () => savedRev(page, photoId), { timeout: 30_000 }).not.toBe(wasAt);
  const kept = details.getByRole('button', { name: 'Edit removal 1' });
  await expect(kept).toBeVisible();
  // The bands the fill touches are prepared again in the worker, and a refusal there is the
  // editor failing rather than anything this page shows in the panel.
  await expect(rebuilding(page)).toHaveCount(0, { timeout: 60_000 });
  await waitForEditorLive(page, 10_000);

  // The row shows the stage around the removal.
  expect(await paintedSum(kept.locator('img'))).toBeGreaterThan(0);

  // Hovering it offers it, and a tap on it reopens it - wherever the move and the pan left it,
  // which its outline says, in the overlay's own pixels.
  const removals = stage.getByRole('img', { name: /^Removal \d+$/ });
  const outline = (await removals.first().getAttribute('points')) ?? '';
  const vertices = outline.split(' ').map((pair) => pair.split(',').map(Number));
  const keptAt = {
    x: box.x + vertices.reduce((sum, [x = 0]) => sum + x, 0) / vertices.length,
    y: box.y + vertices.reduce((sum, [, y = 0]) => sum + y, 0) / vertices.length,
  };
  await page.mouse.move(keptAt.x, keptAt.y);
  await expect.poll(async () => cursorAt(page, keptAt)).toBe('pointer');
  await expect
    .poll(async () => removals.evaluateAll((all) => all.filter((each) => getComputedStyle(each).strokeWidth === '2px').length))
    .toBe(1);
  await page.mouse.click(keptAt.x, keptAt.y);
  await expect(apply).toBeVisible({ timeout: 60_000 });
  await details.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(kept).toBeVisible();

  // Taken off again: left in, the specs below open a photograph with a hole filled in it.
  await details.getByRole('button', { name: 'Delete removal 1' }).click();
  await expect(kept).toBeHidden();
  await tool(page, 'Cursor').click();
});

function rebuilding(page: Page): Locator {
  return page.getByRole('status', { name: 'Rebuilding the photo…' });
}

/**
 * A Detail slider re-prepares the photograph in the worker, band by band, and the editor stays live.
 *
 * What the amount does is native's and the presenter's; what only a browser can say is that what the
 * page hands the worker crosses at all - the document is observable here, and a proxy that reached
 * `postMessage` is a failed editor and nothing else.
 */
test('moving the sharpening prepares the photograph again, and the editor stays live', async ({ page }) => {
  await open(page);
  const wasAt = await savedRev(page, photoId);

  await page.getByRole('slider', { name: 'Sharpening' }).focus();
  await page.keyboard.press('PageUp');
  await expect.poll(async () => savedRev(page, photoId), { timeout: 30_000 }).not.toBe(wasAt);
  await expect(rebuilding(page)).toHaveCount(0, { timeout: 60_000 });
  await waitForEditorLive(page, 10_000);

  await undo(page).click();
  await expect(rebuilding(page)).toHaveCount(0, { timeout: 60_000 });
  await waitForEditorLive(page, 10_000);
});

/**
 * The straighten comes back to exactly zero under a pointer, which nothing else can ask.
 *
 * The snap is the only part of a slider a value test cannot reach: it acts on where the
 * *pointer* landed, and it is measured in pixels of a track this owns none of - a layout, at
 * whatever width the runner's window gives the panel. Base UI's slider takes no headless gesture
 * at all (`CLAUDE.md`), so a real mouse on a real track is the only thing that can answer.
 *
 * One pixel off the middle, which is what a reader aiming at it lands on. Under the window at
 * every width, and far enough from zero to be a different answer: a third of a degree here, and
 * more on a narrower panel.
 */
test('the straighten lands on exactly zero when a drag comes near it', async ({ page }) => {
  await open(page);

  // Through the crop tool, where the panel is this control and one checkbox. In the panel it
  // shares with every slider the row is below the fold, and a mouse moved to a point outside the
  // window reaches nothing at all - which reads as a slider that ignored the drag.
  await tool(page, 'Crop').click();
  const straighten = page.getByRole('slider', { name: 'Straighten' });
  // The slider's own root, innermost of the groups around it, is the box its track spans.
  const track = page.getByRole('group').filter({ has: straighten }).last();
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  if (box == null) throw new Error('the straighten has no track');
  const middle = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // From well off zero, so this is a drag towards the middle rather than a press that lands
  // there - the two reach the snap by different reasons, and the drag is the one a reader makes.
  await page.mouse.move(middle + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(middle + 1, y, { steps: 10 });
  await page.mouse.up();

  await expect(straighten).toHaveValue('0');
  await tool(page, 'Cursor').click();
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

  const exposure = page.getByRole('slider', { name: 'Exposure' });
  const started = await exposure.inputValue();
  const wasAt = await savedRev(page, photoId);

  await exposure.focus();
  // One press, because one settle is one history entry and the undo below steps once.
  await page.keyboard.press('PageDown');

  const moved = await exposure.inputValue();
  expect(moved).not.toBe(started);
  // The commit is on release, so the revision moving is what says the drag reached the
  // server rather than only the shader.
  await expect.poll(async () => savedRev(page, photoId), { timeout: 30_000 }).not.toBe(wasAt);

  await open(page);
  await expect(exposure).toHaveValue(moved);
  await expect(undo(page)).toBeEnabled();

  // And the history came back with it: undo is what proves the deltas were stored, not
  // just the document.
  await undo(page).click();
  await expect(exposure).toHaveValue(started);
  await expect(page.getByRole('group', { name: 'Photo controls' }).getByRole('button', { name: 'Redo' })).toBeEnabled();
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
  await expect(editTools(page)).toBeHidden();
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
  // The editor's own open, which is served from the same prefix as the frames this is about: the
  // RAW the tab decodes and the match it opens with.
  const opening = [route(PathSegment.download(), PathSegment.original()), route(PathSegment.analysis())];
  const asked: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(`${route(PathSegment.image())}/`) && !opening.some((part) => path.endsWith(part))) asked.push(path);
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
  await page.goto(route(PathSegment.photos(), photoId));
  await expect(page.getByRole('button', { name: 'More' })).toBeEnabled();

  // Through the menu the reader uses, because it is `startEdit` that puts anything in the
  // history and `?edit` in the address arrives without having called it.
  const before = await page.evaluate(() => history.length);
  await photoAction(page, 'Actions', 'Edit', { exact: true });
  await expect(editTools(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editTools(page)).toBeHidden();

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
  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await waitForEditorLive(page);
}

/**
 * The loupe, which is the part of it that needs a browser.
 *
 * Which pixels it magnifies is arithmetic and lives in `raw_edit_presenter.test.ts`. What only a
 * real one can say is that a pointer moving over a real element puts a second WebGPU canvas on
 * the page, and that a wheel over it reaches the magnification rather than the page's scroll.
 */
test('the loupe follows a real pointer and takes a real wheel', async ({ page }) => {
  await open(page);

  await tool(page, 'Loupe').click();
  // The glass is a canvas of its own, drawn by the same pipeline rather than a scaled copy.
  const loupe = photoStage(page).getByRole('img', { name: 'Magnified view', includeHidden: true });
  const scale = photoStage(page).getByText(/^[\d.]+×$/);

  // Nothing to magnify until the pointer is over the picture.
  await expect(loupe).toHaveCSS('visibility', 'hidden');

  const centre = middleOf(await stageBox(page));
  await page.mouse.move(centre.x, centre.y);

  await expect(loupe).toBeVisible();
  await expect(scale).toHaveText('2.0×');

  // It rides the pointer: the box is centred on wherever the cursor is.
  const before = await loupe.boundingBox();
  await page.mouse.move(centre.x + 120, centre.y);
  const after = await loupe.boundingBox();
  expect(after!.x).toBeGreaterThan(before!.x + 100);

  // And the wheel is the magnification's, not the page's.
  await page.mouse.wheel(0, -120);
  await expect(scale).not.toHaveText('2.0×');

  // Leaving the tool puts the glass away.
  await tool(page, 'Cursor').click();
  await expect(loupe).toBeHidden();
});

test('editor rotation lives in overflow and saves orientation edit', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('button', { name: 'Rotate right' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More' }).click();
  const view = page.getByRole('group', { name: 'View' });
  await expect(view.getByRole('menuitem', { name: 'Rotate left' })).toBeVisible();
  await view.getByRole('menuitem', { name: 'Rotate right' }).click();
  await expect.poll(async () => {
    const response = await page.request.get(route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits()));
    const state = (await response.json()) as { doc: { rotate: number } };
    return state.doc.rotate;
  }).toBe(90);
});

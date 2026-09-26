import { type Locator, type Page, expect } from '@playwright/test';
import { test } from '../fixtures';
import { z } from 'zod';
import { EditStateSchema, TONE_CURVE_KIND } from '../../../src/schemas/photo_edits';
import { PathSegment, route } from '../../../src/schemas/route';
import { EDIT_PHOTOS_DIR } from '../fixture_library';
import {
  addLibrary,
  editDiagnosticSize,
  editDiagnostics,
  editorFailure,
  editPreview,
  editTools,
  emulateHdrDisplay,
  firstPhotoId,
  photoAction,
  photoStage,
  savedRev,
  softProof,
  waitForEditorLive,
  watchForComplaints,
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
  photoId = await firstPhotoId(page, EDIT_PHOTOS_DIR);
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
 *
 * The open is the tab's own: there is nothing on the server to prepare a frame any more, so the
 * request it did not get is what would catch a transport creeping back in, and the console is what
 * says the frame that went live was not half-written by a refused dispatch.
 */
test('opens in the tab and grades on the GPU, into a stage sized for the viewport', async ({ page }) => {
  const askedTheServer: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(route(PathSegment.prepared()))) askedTheServer.push(request.url());
  });
  const declined = watchForComplaints(page);
  // Stored rather than dragged: what a value *does* is answered without a browser, so the only
  // reason to set one here is to make the passes run. In a `finally`, because leaking a clarity
  // of 100 into the specs below would be a photograph none of them meant to open.
  await setClarity(page, 100);
  try {
    await gradesOnTheGpu(page);
  } finally {
    await setClarity(page, 0);
  }
  expect(askedTheServer).toEqual([]);
  expect(declined).toEqual([]);
});

async function setClarity(page: Page, clarity: number): Promise<void> {
  const editsUrl = route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits());
  const was = EditStateSchema.parse(await (await page.request.get(editsUrl)).json());
  const saved = await page.request.put(editsUrl, {
    data: { doc: { ...was.doc, clarity }, rev: was.rev, session: 'rawEditingSpec' },
  });
  expect(saved.ok()).toBe(true);
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

  // The camera match has to reach the client, and no other check can see that it did:
  // without it the grade takes its neutral arm and still produces a plausible HDR frame at
  // the right size, just flatter and less saturated than the rendition of the same file.
  // It has been wrong twice before, both times numerically and silently (DESIGN 21.1), so what
  // this guards is the hand-off: the curves, the matrix and the chroma lattice crossing as arrays
  // a shader can index, rather than being dropped somewhere in the header.
  await expect(editDiagnostics(page)).toHaveAttribute('data-matched', 'true');

  // The camera neutral reaches the client too: what the sliders *do* with it is
  // `raw_edit_presenter.test.ts`, and a header without it leaves the pair absent entirely.
  await expect(page.getByRole('group', { name: 'White balance' }).getByRole('textbox', { name: 'Temperature value' }))
    .toHaveValue(/^[\d.]+ K$/);
}

/**
 * The soft proof names its target and its rendering intent as bare strings, and this is the only
 * runner that can see whether the module accepts them.
 *
 * `wasm::set_proof` matches `"hdr"` and `"srgb"` and parses the intent, and a print scene's
 * presentation and rendering intent are serde's names, where the page's are TypeScript unions the module knows nothing about - so a
 * value renamed on either side compiles, passes `raw_edit_presenter.test.ts` against its recording
 * decoder, and refuses at the first tick. `wasm.rs` is `#[cfg(target_arch = "wasm32")]`, so no
 * cargo suite compiles that match either way.
 *
 * What a proof *does* to the picture is the presenter's test and `print_rendering.rs`; what needs
 * a browser is that every name survives the crossing and the tick still draws.
 */
test('every soft proof crosses to the module and keeps drawing', async ({ page }) => {
  await open(page);

  for (const [label, shown, panel] of [
    ['SDR (sRGB)', 'SDR', 'Tone mapping'],
    ['Printed media', 'Printed media', 'Paper'],
    ['HDR (Rec.2020 PQ)', 'HDR', null],
  ] as const) {
    await softProof(page, label);
    if (label === 'SDR (sRGB)') {
      await page.getByRole('combobox', { name: 'Rendering intent' }).click();
      await page.getByRole('option', { name: 'Relative colorimetric', exact: true }).click();
    }
    if (label === 'Printed media') {
      await page.getByRole('checkbox', { name: 'Black point compensation' }).uncheck();
    }
    await expect(page.getByRole('button', { name: /^Soft proof/ })).toHaveText(shown);
    if (panel != null) await expect(page.getByRole('group', { name: panel, exact: true })).toBeVisible();
    // A refused command comes back asynchronously and lands on the tick after it
    // (`gpu::refusal`), so the status is read for a while rather than once.
    await waitForEditorLive(page, 10_000);
    await expect(editDiagnostics(page)).toHaveAttribute('data-adapter', /./);
  }
  await expect(page.getByRole('group', { name: 'Paper', exact: true })).toHaveCount(0);
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

  const failure = editorFailure(page);
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(missing);
  await expect(failure).not.toContainText('[object Object]');
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

test('tone curve points drag and drag off the plot', async ({ page }) => {
  const editsUrl = route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits());
  const state = async () => EditStateSchema.parse(await (await page.request.get(editsUrl)).json());
  const original = await state();
  const seeded = await page.request.put(editsUrl, {
    data: { doc: { ...original.doc, exposure: null, toneCurve: { kind: TONE_CURVE_KIND, points: [[0, 0], [1, 1]] } }, rev: original.rev, session: 'rawEditingSpec' },
  });
  expect(seeded.ok()).toBe(true);
  const seededState = EditStateSchema.parse(await seeded.json());
  const savedByEditor = () => page.waitForResponse((response) =>
    response.url().endsWith(editsUrl) && response.request().method() === 'PUT', { timeout: 30_000 });

  try {
    await open(page);
    const exposure = page.getByRole('slider', { name: 'Exposure', exact: true });
    const thumb = await exposure.evaluate((input) => {
      const box = input.parentElement?.getBoundingClientRect();
      if (box == null) throw new Error('exposure has no thumb');
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    const neutralCommit = savedByEditor();
    await page.mouse.click(thumb.x, thumb.y);
    expect(EditStateSchema.parse(await (await neutralCommit).json()).doc.exposure).toBeNull();
    const plot = page.getByRole('group', { name: 'Tone curve' });
    const plotBox = await plot.boundingBox();
    if (plotBox == null) throw new Error('tone curve has no plot');
    const insertedSave = savedByEditor();
    await page.mouse.click(plotBox.x + plotBox.width / 2, plotBox.y + plotBox.height / 2);
    const insertedState = EditStateSchema.parse(await (await insertedSave).json());
    expect(insertedState.doc.toneCurve?.points).toHaveLength(3);
    const point = plot.getByRole('slider', { name: /^Curve point 1,/ });
    await expect(point).toBeVisible();
    const originalName = await point.getAttribute('aria-label');
    const pointBox = await point.boundingBox();
    if (plotBox == null || pointBox == null) throw new Error('tone curve has no plot or point');

    const x = pointBox.x + pointBox.width / 2;
    const y = pointBox.y + pointBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + plotBox.width * 0.05, y - plotBox.height * 0.05, { steps: 3 });
    await expect(point).not.toHaveAttribute('aria-label', originalName ?? '');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(editTools(page)).toBeVisible();
    await expect(point).toHaveAttribute('aria-label', originalName ?? '');
    const cancelledState = await state();
    expect(cancelledState.doc.toneCurve).toEqual(insertedState.doc.toneCurve);
    expect(cancelledState.rev).toBe(insertedState.rev);

    await page.mouse.move(x, y);
    const movedSave = savedByEditor();
    await page.mouse.down();
    await expect(point).toBeFocused();
    await page.mouse.move(x + plotBox.width * 0.1, y - plotBox.height * 0.1, { steps: 6 });
    await page.mouse.up();

    await expect(point).not.toHaveAttribute('aria-label', originalName ?? '');
    const movedState = EditStateSchema.parse(await (await movedSave).json());
    expect(movedState.doc.toneCurve?.points[1]?.[0]).toBeGreaterThan(0.55);
    expect(movedState.doc.toneCurve?.points[1]?.[1]).toBeGreaterThan(0.55);
    expect(movedState.rev).toBeGreaterThan(seededState.rev);

    const movedBox = await point.boundingBox();
    if (movedBox == null) throw new Error('tone curve point disappeared before removal');
    await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + movedBox.height / 2);
    const removedSave = savedByEditor();
    await page.mouse.down();
    await page.mouse.move(plotBox.x - plotBox.width * 0.2, plotBox.y + plotBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(plot.getByRole('slider', { name: /^Curve point/ })).toHaveCount(0);
    const removedState = EditStateSchema.parse(await (await removedSave).json());
    expect(removedState.doc.toneCurve?.points).toHaveLength(2);
    expect(removedState.rev).toBeGreaterThan(movedState.rev);
    const reinsertedSave = savedByEditor();
    await page.mouse.click(plotBox.x + plotBox.width / 2, plotBox.y + plotBox.height / 2);
    await reinsertedSave;
    const doubleClickSave = savedByEditor();
    await plot.getByRole('slider', { name: /^Curve point 1,/ }).dblclick();
    const doubleClickedState = EditStateSchema.parse(await (await doubleClickSave).json());
    expect(doubleClickedState.doc.toneCurve?.points).toHaveLength(2);
    await expect(plot.getByRole('slider', { name: /^Curve point/ })).toHaveCount(0);
  } finally {
    const current = await state();
    const restored = await page.request.put(editsUrl, {
      data: { doc: original.doc, rev: current.rev, session: 'rawEditingSpec' },
    });
    expect(restored.ok()).toBe(true);
  }
});

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
 * Which pixels it magnifies is arithmetic and lives in `raw_edit_presenter.test.ts`, and what the
 * tile it sharpens from *is* is `tile.rs`. What only a real one can say is that a pointer moving
 * over a real element puts a second WebGPU canvas on the page, that a wheel over it reaches the
 * magnification rather than the page's scroll, and that the tile is built in the tab.
 *
 * Two assertions about the tile and neither is redundant. **The route was never asked** says the
 * tile was built here rather than fetched; **the glass says it is holding one** says a tile was
 * built at all, since a magnifier showing the tick's own render for ever would ask for nothing
 * either. A tile denoised by nothing still produces a picture, so the console is watched too.
 */
test('the loupe follows a real pointer, takes a real wheel, and sharpens from a tile built in the tab', async ({ page }) => {
  const askedTheServer: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(route(PathSegment.tile()))) askedTheServer.push(request.url());
  });
  const declined = watchForComplaints(page);
  await open(page);

  await tool(page, 'Loupe').click();
  // The glass is a canvas of its own, drawn by the same pipeline rather than a scaled copy.
  const loupe = photoStage(page).getByRole('img', { name: 'Magnified view', includeHidden: true });
  const scale = photoStage(page).getByText(/^[\d.]+×$/);

  // Nothing to magnify until the pointer is over the picture.
  await expect(loupe).toHaveCSS('visibility', 'hidden');

  // Watched for rather than polled: a tile takes tens of milliseconds, so the spinner can come and
  // go between two of Playwright's polls.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[role="status"][aria-label="Rendering"]') == null) return;
      document.documentElement.dataset.sawRendering = 'true';
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const centre = middleOf(await stageBox(page));
  // Held still: nothing is asked for while the pointer moves, and a tile is what a reader who
  // has stopped somewhere gets.
  await page.mouse.move(centre.x, centre.y);

  await expect(loupe).toBeVisible();
  await expect(scale).toHaveText('2.0×');
  // The glass says the export's pixels are on their way while it shows the tick's own, and stops
  // once it holds them.
  await expect(page.locator('html')).toHaveAttribute('data-saw-rendering', 'true', { timeout: 60_000 });
  await expect(photoStage(page).getByRole('status', { name: 'Rendering' })).toHaveCount(0, { timeout: 60_000 });
  expect(askedTheServer).toEqual([]);
  expect(declined).toEqual([]);

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

test('print mode rotates with a real pointer and keyboard without saving a photo edit', async ({ page }) => {
  await page.route(/\/gpu_worker\.ts(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `
        const hdrConfigurations = [];
        const hdrReadbacks = [];
        const editorCanvases = new WeakSet();
        const editorTextures = new WeakSet();
        const editorViews = new WeakMap();
        let editorDevice;
        let currentPrint;
        let drawnTexture;
        let wantedReadback;
        let readbackId = 0;
        self.addEventListener('message', (event) => {
          const ask = event.data?.ask;
          if (ask?.kind === 'attach' && ask.which === 'stage') editorCanvases.add(ask.canvas);
          if (ask?.kind === 'tick') currentPrint = ask.print;
        });
        Object.defineProperty(globalThis, 'editorCanvasConfigurations', { get: () => hdrConfigurations });
        Object.defineProperty(globalThis, 'editorCanvasReadbacks', { get: () => hdrReadbacks });
        Object.defineProperty(globalThis, 'requestEditorReadback', { value: (scene) => {
          wantedReadback = { id: ++readbackId, scene };
          return readbackId;
        }});
        const configureHdrCanvas = GPUCanvasContext.prototype.configure;
        GPUCanvasContext.prototype.configure = function (configuration) {
          const editorCanvas = editorCanvases.has(this.canvas);
          configureHdrCanvas.call(this, editorCanvas
            ? { ...configuration, usage: configuration.usage | GPUTextureUsage.COPY_SRC }
            : configuration);
          if (!editorCanvases.has(this.canvas)) return;
          editorDevice = configuration.device;
          const actual = this.getConfiguration();
          hdrConfigurations.push({ format: actual.format, colorSpace: actual.colorSpace, toneMapping: actual.toneMapping?.mode ?? null });
        };
        const getHdrTexture = GPUCanvasContext.prototype.getCurrentTexture;
        GPUCanvasContext.prototype.getCurrentTexture = function () {
          const texture = getHdrTexture.call(this);
          if (editorCanvases.has(this.canvas)) editorTextures.add(texture);
          return texture;
        };
        const createHdrView = GPUTexture.prototype.createView;
        GPUTexture.prototype.createView = function (descriptor) {
          const view = createHdrView.call(this, descriptor);
          if (editorTextures.has(this)) editorViews.set(view, this);
          return view;
        };
        const beginHdrPass = GPUCommandEncoder.prototype.beginRenderPass;
        GPUCommandEncoder.prototype.beginRenderPass = function (descriptor) {
          for (const attachment of descriptor.colorAttachments) {
            if (attachment != null && editorViews.has(attachment.view)) drawnTexture = editorViews.get(attachment.view);
          }
          return beginHdrPass.call(this, descriptor);
        };
        const halfFloat = (word) => {
          const sign = word & 32768 ? -1 : 1;
          const exponent = (word >> 10) & 31;
          const fraction = word & 1023;
          return sign * (exponent === 0 ? fraction * 2 ** -24
            : exponent === 31 ? (fraction === 0 ? Infinity : NaN) : (1 + fraction / 1024) * 2 ** (exponent - 15));
        };
        const submitHdrCommands = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function (commands) {
          const texture = drawnTexture;
          drawnTexture = null;
          const requested = wantedReadback;
          if (texture == null || requested == null ||
              !Object.entries(requested.scene).every(([key, value]) => currentPrint?.[key] === value)) {
            return submitHdrCommands.call(this, commands);
          }
          wantedReadback = null;
          const scene = { ...currentPrint };
          // A block around the middle rather than the middle pixel: a small source puts a small
          // highlight somewhere on the sheet, and which texel it lands on is not the claim.
          const side = Math.min(512, texture.width, texture.height) & ~31;
          const buffer = editorDevice.createBuffer({ size: side * side * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const encoder = editorDevice.createCommandEncoder();
          encoder.copyTextureToBuffer(
            { texture, origin: { x: Math.floor((texture.width - side) / 2), y: Math.floor((texture.height - side) / 2) } },
            { buffer, bytesPerRow: side * 8 },
            { width: side, height: side },
          );
          submitHdrCommands.call(this, [...commands, encoder.finish()]);
          buffer.mapAsync(GPUMapMode.READ).then(() => {
            const raw = new DataView(buffer.getMappedRange());
            let rgb = [0, 0, 0];
            for (let at = 0; at < side * side * 8; at += 8) {
              const pixel = [halfFloat(raw.getUint16(at, true)), halfFloat(raw.getUint16(at + 2, true)), halfFloat(raw.getUint16(at + 4, true))];
              if (Math.max(...pixel) > Math.max(...rgb)) rgb = pixel;
            }
            hdrReadbacks.push({ id: requested.id, scene, rgb });
            buffer.unmap();
            buffer.destroy();
          });
        };
        ${await response.text()}
      `,
    });
  });
  await emulateHdrDisplay(page);
  await open(page);
  const worker = page.workers().find((worker) => worker.url().includes('gpu_worker'));
  if (worker == null) throw new Error('The GPU worker was not created');
  const Configurations = z.array(z.object({ format: z.string(), colorSpace: z.string(), toneMapping: z.string().nullable() }));
  const canvasConfigurations = async (): Promise<z.infer<typeof Configurations>> => Configurations.parse(
    await worker.evaluate(() => Reflect.get(globalThis, 'editorCanvasConfigurations')),
  );
  const hdrCanvas = { format: 'rgba16float', colorSpace: 'display-p3', toneMapping: 'extended' };
  expect(await canvasConfigurations()).toContainEqual(hdrCanvas);
  const revision = await savedRev(page, photoId);
  await softProof(page, 'Printed media (3D)');
  // After a shader changes, the driver's cache is cold and the sheet's pipeline compiles on this draw.
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', { timeout: 60_000 });
  const frame = page.getByRole('checkbox', { name: 'Add frame', exact: true });
  await expect(frame).not.toBeChecked();
  await frame.check();
  await expect(frame).toBeChecked();
  for (const configuration of await canvasConfigurations()) expect(configuration).toEqual(hdrCanvas);
  const print = page.getByRole('region', { name: 'Rotate print' });
  const yaw = page.getByRole('slider', { name: 'Horizontal rotation', exact: true });
  await expect(print).toBeVisible();
  await expect(yaw).toHaveAttribute('aria-valuenow', '-12');
  const box = await print.boundingBox();
  if (box == null) throw new Error('The print stage has no layout box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 30, { steps: 8 });
  await page.mouse.up();
  await expect(yaw).not.toHaveAttribute('aria-valuenow', '-12');
  await print.press('Home');
  await expect(yaw).toHaveAttribute('aria-valuenow', '-12');
  await print.press('ArrowRight');
  await expect(yaw).toHaveAttribute('aria-valuenow', '-7');
  await page.getByRole('combobox', { name: 'Paper', exact: true }).click();
  await page.getByRole('option', { name: 'Gloss', exact: true }).click();
  await print.press('Home');
  await print.press('Shift+ArrowUp');
  await print.press('Shift+ArrowUp');
  await print.press('Shift+ArrowUp');
  await print.press('ArrowRight');
  await print.press('ArrowRight');
  await expect(page.getByRole('slider', { name: 'Vertical rotation' })).toHaveAttribute('aria-valuenow', '-37');
  const readbackId = z.number().parse(await worker.evaluate(() => {
    const request = Reflect.get(globalThis, 'requestEditorReadback');
    return request({ paper: 'gloss', yawDegrees: -2, pitchDegrees: -37, keyLux: 10000 });
  }));
  await page.getByRole('slider', { name: 'Light intensity' }).press('End');
  const Readbacks = z.array(z.object({ id: z.number(), rgb: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]) }));
  const readbacks = async (): Promise<z.infer<typeof Readbacks>> => Readbacks.parse(
    await worker.evaluate(() => Reflect.get(globalThis, 'editorCanvasReadbacks')),
  );
  await expect.poll(async () => (await readbacks()).some((frame) => frame.id === readbackId)).toBe(true);
  const rendered = (await readbacks()).find((frame) => frame.id === readbackId);
  if (rendered == null) throw new Error('The print framebuffer was not read back');
  expect(Math.max(...rendered.rgb)).toBeGreaterThan(1.5);
  await test.info().attach('print-canvas-hdr.json', { body: JSON.stringify(rendered), contentType: 'application/json' });
  const compositing = await print.getByRole('img', { name: 'Edit preview' }).evaluate((canvas) => {
    const layers = [];
    for (let element: Element | null = canvas; element != null; element = element.parentElement) {
      const style = getComputedStyle(element);
      layers.push({ tag: element.tagName, opacity: style.opacity, filter: style.filter, transform: style.transform, blend: style.mixBlendMode });
    }
    return layers;
  });
  expect(compositing.filter((layer) => layer.opacity !== '1' || layer.filter !== 'none' || layer.transform !== 'none' || layer.blend !== 'normal')).toEqual([]);
  await expect(editorFailure(page)).toHaveCount(0);
  expect(await savedRev(page, photoId)).toBe(revision);
  await softProof(page, 'HDR (Rec.2020 PQ)');
  await waitForEditorLive(page);
  await expect(editTools(page)).toBeVisible();
  await expect(print).toHaveCount(0);
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'photo');
  await expect(editPreview(page)).toBeVisible();
});

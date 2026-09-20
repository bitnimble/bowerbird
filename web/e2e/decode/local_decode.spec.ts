import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { DECODE_PHOTOS_DIR, DECODE_PHOTO_NAMES } from '../fixture_library';
import {
  addLibrary,
  editDiagnosticSize,
  editDiagnostics,
  editTools,
  openLibrary,
  openPhoto,
  openPhotoId,
  photoStage,
  scanLibrary,
  waitForEditorLive,
  waitForScanSettled,
} from '../helpers';

// **The one claim a cargo build cannot make.** The crate has linked for wasm32 for a while and
// `tests/wasm_build.rs` pins what a host can ask of it, but neither can say whether the module
// survives a real RAW in a real tab: whether wasm-bindgen's bindings match what the page calls,
// whether the decode completes inside a tab's memory, and whether a browser's own adapter answers.
// Those need a browser, so they live here and nowhere else.

// An open is a real decode of a real ARW in a tab, on one core for the stages that are not the
// GPU's, so these carry their own timeout as the editor's own spec does.
test.describe.configure({ timeout: 180_000 });

/**
 * Everything the module says on the console that means the picture is not the one it should be.
 *
 * **A frame arrives either way, which is why this is watched at all.** A dispatch the browser
 * refused writes nothing and the stages after it filter whatever the one before left, so what comes
 * back is a photograph rather than a failure - `gpu.rs`'s uncaptured-error handler is the only thing
 * in a tab that says so. A decode with no noise fit is a frame that was never denoised.
 *
 * Matched on the exact prefixes rather than on `rawshim`, because the module also logs which adapter
 * it opened, and a filter that swept those up would fail every run.
 */
const COMPLAINTS = [
  'rawshim gpu: the browser refused a command',
  'rawshim: no noise fit was measured',
];

/** Collects those, for a test that asserts none of them arrived. */
function watchForComplaints(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (COMPLAINTS.some((prefix) => text.startsWith(prefix))) seen.push(text);
  });
  return seen;
}

let photoId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await addLibrary(page, DECODE_PHOTOS_DIR);
  await scanLibrary(page, DECODE_PHOTOS_DIR);
  await waitForScanSettled(page, DECODE_PHOTOS_DIR, DECODE_PHOTO_NAMES.length);
  await openLibrary(page, DECODE_PHOTOS_DIR);
  await openPhoto(page);
  photoId = openPhotoId(page);
  await page.close();
});

test('decodes a RAW in the tab, at the sensor it was shot on', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), photoId));

  // The assertions below cannot tell a frame the kernels made from one a refused dispatch left
  // half-written, so the console is the only evidence from here that they ran.
  const declined = watchForComplaints(page);

  const opened = await page.evaluate(async (originalUrl) => {
    const { LocalDecoder } = await import('/src/features/raw_edit/local_decode/local_decoder.ts');
    const raw = new Uint8Array(
      await (await fetch(originalUrl)).arrayBuffer(),
    );
    const bytes = raw.byteLength;
    const decoder = new LocalDecoder();
    // The bytes are transferred to the decoder's thread, so `raw` is detached from here on.
    await decoder.hold(raw);
    // `longEdge: 0` is the sensor's own, which is what the halving decision is being held to.
    const header = await decoder.prepare(
      {
        longEdge: 0,
        grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
        defringe: 1,
      },
      // The dust switch off: what this asks is whether a decode reaches the sensor's own size and
      // measures its own numbers, and a search of the cover glass is a second thing to wait for.
      {
        luminance: 20,
        colour: 30,
        sharpen: 0.3,
        dust: { enabled: false, sensitivity: 0.25, intensity: 1 },
        repairs: [],
      },
    );
    decoder.close();
    return { bytes, header: JSON.parse(header) };
  }, route(PathSegment.image(), photoId, PathSegment.download(), PathSegment.original()));

  expect(opened.bytes).toBeGreaterThan(1_000_000);
  expect(opened.header.width).toBeGreaterThan(2000);
  expect(opened.header.height).toBeGreaterThan(2000);
  // **The frame is never seen from here**, so what stands in for looking at it is what was read
  // off it. `white` and `peak` are quantiles over the whole frame: a decode that produced the
  // right shape from the wrong buffer reads them as zero or as saturated, which a size check
  // cannot see. The noise fit is the other half - it is measured on the mosaic, and its absence
  // is a chain that never ran.
  expect(opened.header.white).toBeGreaterThan(0);
  expect(opened.header.peak).toBeGreaterThan(opened.header.white);
  expect(opened.header.noiseFit).toBeDefined();
  expect(declined).toEqual([]);
});

/**
 * The editor opening a photograph without a prepared frame ever crossing the network.
 *
 * There is nothing on the server to ask any more, so an editor that reaches `live` opened here.
 * The request the server did not get is kept as the assertion regardless: it is what would catch
 * a transport creeping back in, and it costs nothing.
 */
test('opens a RAW in the tab, without asking the server to prepare one', async ({ page }) => {
  const askedTheServer: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(route(PathSegment.prepared()))) askedTheServer.push(request.url());
  });
  // An open that reached `live` off a half-written frame looks like this working.
  const declined = watchForComplaints(page);

  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await waitForEditorLive(page);

  expect(declined).toEqual([]);
  expect(askedTheServer).toEqual([]);

  // The frame reached the editor whole, rather than the editor going live on a header it built
  // for itself: the size is the decode's, and the match is the one the open fitted or was handed.
  const [width, height] = await editDiagnosticSize(page, 'data-size');
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(1000);
  await expect(editDiagnostics(page)).toHaveAttribute('data-matched', 'true');
});

/**
 * The loupe sharpening without a round trip, which is the last thing the editor asked a server for.
 *
 * Two assertions and neither is redundant. **The route was never asked** is what says the tile was
 * built here rather than fetched; **the glass says it is holding one** is what says a tile was
 * built at all, since a magnifier showing the tick's own render for ever would ask for nothing
 * either. The fall-throughs are watched for the reason the decode above watches them: a tile
 * denoised by nothing still produces a picture.
 *
 * What the tile *is* - the window, the rectangle kept inside it, the reach each stage adds - is
 * arithmetic, and `tile.rs` pins it where it costs microseconds rather than an editor open.
 */
test('sharpens the loupe from a tile decoded in the tab', async ({ page }) => {
  const askedTheServer: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith(route(PathSegment.tile()))) askedTheServer.push(request.url());
  });
  const declined = watchForComplaints(page);

  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await waitForEditorLive(page);

  await editTools(page).getByRole('radio', { name: 'Loupe' }).click();
  const stage = photoStage(page);
  const box = await stage.boundingBox();
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
  // Held still: nothing is asked for while the pointer moves, and a tile is what a reader who
  // has stopped somewhere gets.
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(stage.getByRole('img', { name: 'Magnified view' })).toBeVisible();
  // The glass says the export's pixels are on their way while it shows the tick's own, and stops
  // once it holds them.
  await expect(page.locator('html')).toHaveAttribute('data-saw-rendering', 'true', { timeout: 60_000 });
  await expect(stage.getByRole('status', { name: 'Rendering' })).toHaveCount(0, { timeout: 60_000 });

  expect(askedTheServer).toEqual([]);
  expect(declined).toEqual([]);
});

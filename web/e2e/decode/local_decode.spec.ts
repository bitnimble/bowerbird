import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { DECODE_PHOTOS_DIR, DECODE_PHOTO_NAMES } from '../fixture_library';
import { addLibrary, firstPhotoId, watchForComplaints } from '../helpers';

// **The one claim a cargo build cannot make.** The crate has linked for wasm32 for a while and
// `tests/wasm_build.rs` pins what a host can ask of it, but neither can say whether the module
// survives a real RAW in a real tab: whether wasm-bindgen's bindings match what the page calls,
// whether the decode completes inside a tab's memory, and whether a browser's own adapter answers.
// That the editor opens and sharpens its loupe off this decode, and asks the server for neither,
// is `editor/raw_editing.spec.ts`.

// A real decode of a real ARW in a tab, on one core for the stages that are not the GPU's, so
// these carry their own timeout as the editor's own spec does.
test.describe.configure({ timeout: 180_000 });

let photoId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await addLibrary(page, DECODE_PHOTOS_DIR, { photos: DECODE_PHOTO_NAMES.length });
  photoId = await firstPhotoId(page, DECODE_PHOTOS_DIR);
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
    const stages: string[] = [];
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
        denoiser: 'galosh',
        sharpen: 0.3,
        dust: { enabled: false, sensitivity: 0.25, intensity: 1 },
        repairs: [],
      },
      (stage) => stages.push(stage),
    );
    decoder.close();
    return { bytes, header: JSON.parse(header), stages };
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
  // What the stage names while it waits, each as the module begins it: dust is off, so no search.
  expect(opened.stages).toEqual(['decoding', 'measuring-noise', 'denoising', 'demosaicing', 'matching', 'correcting']);
});

/**
 * PMRID denoising in the tab, off weights the page fetched rather than the module carried.
 *
 * **Only a browser can answer this**: the weights are four megabytes served beside the module under
 * their own hash (`scripts/hash-pkg.ts`), and what is being asked is whether the URL the bundler
 * emitted resolves, whether the bytes reach `holdPmridWeights`, and whether the network then has
 * what it needs. The module says so on the console when they never arrived, and that line is one of
 * the complaints watched for above - so a frame that came back undenoised fails here rather than
 * passing as a photograph.
 *
 * The request is the assertion's other half: a reader who never leaves GALOSH must not pay for this
 * download, and the test above is that reader.
 */
test('denoises in the tab with PMRID, off weights fetched beside the module', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), photoId));
  const declined = watchForComplaints(page);
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (/pmrid_weights\.[0-9a-f]+\.bin$/.test(new URL(request.url()).pathname)) {
      fetched.push(request.url());
    }
  });

  const opened = await page.evaluate(async (originalUrl) => {
    const { LocalDecoder } = await import('/src/features/raw_edit/local_decode/local_decoder.ts');
    const raw = new Uint8Array(await (await fetch(originalUrl)).arrayBuffer());
    const decoder = new LocalDecoder();
    await decoder.hold(raw);
    const header = await decoder.prepare(
      {
        longEdge: 0,
        grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
        defringe: 1,
      },
      {
        luminance: 100,
        colour: 100,
        denoiser: 'pmrid',
        sharpen: 0.3,
        dust: { enabled: false, sensitivity: 0.25, intensity: 1 },
        repairs: [],
      },
    );
    decoder.close();
    return JSON.parse(header);
  }, route(PathSegment.image(), photoId, PathSegment.download(), PathSegment.original()));

  expect(opened.width).toBeGreaterThan(2000);
  expect(opened.white).toBeGreaterThan(0);
  expect(opened.noiseFit).toBeDefined();
  expect(declined).toEqual([]);
  expect(fetched).toHaveLength(1);
});

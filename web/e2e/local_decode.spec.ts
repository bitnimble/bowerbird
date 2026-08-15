import { expect, test } from '@playwright/test';
import { DECODE_PHOTOS_DIR, DECODE_PHOTO_NAMES } from './fixture_library';
import {
  addLibrary,
  openLibrary,
  openPhoto,
  openPhotoId,
  syncLibrary,
  waitForSyncSettled,
} from './helpers';

// **The one claim a cargo build cannot make.** The crate has linked for wasm32 for a while and
// `tests/wasm_build.rs` pins what a host can ask of it, but neither can say whether the module
// survives a real RAW in a real tab: whether wasm-bindgen's bindings match what the page calls,
// whether the decode completes inside a tab's memory, and whether a browser's own adapter answers.
// Those need a browser, so they live here and nowhere else.

// An open is a real decode of a real ARW in a tab, on one core for the stages that are not the
// GPU's, so these carry their own timeout as the editor's own spec does.
test.describe.configure({ timeout: 180_000 });

let photoId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await addLibrary(page, DECODE_PHOTOS_DIR);
  await syncLibrary(page, DECODE_PHOTOS_DIR);
  await waitForSyncSettled(page, DECODE_PHOTOS_DIR, DECODE_PHOTO_NAMES.length);
  await openLibrary(page, DECODE_PHOTOS_DIR);
  await openPhoto(page);
  photoId = openPhotoId(page);
  await page.close();
});

test('decodes a RAW in the tab, at the sensor it was shot on', async ({ page }) => {
  await page.goto(`/photos/${photoId}`);

  // **A decode that fell through to the CPU produces a picture too**, so the shape assertions below
  // cannot tell RCD from the PPG it replaced. Each fall-through announces itself on the console
  // (`rawshim::warn`), and their absence is the only evidence from here that the tab ran the
  // kernels rather than the reconstruction they exist to beat.
  const declined: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('rawshim: no ')) {
      declined.push(message.text());
    }
  });

  const decoded = await page.evaluate(async (id) => {
    const { LocalDecoder } = await import('/src/features/raw_edit/local_open.ts');
    const raw = new Uint8Array(
      await (await fetch(`/image/${id}/download/original`)).arrayBuffer(),
    );
    const decoder = new LocalDecoder();
    const frame = await decoder.open(raw, 0);
    return {
      bytes: raw.byteLength,
      width: frame.width,
      height: frame.height,
      halved: frame.halved,
      samples: frame.samples.length,
      // Not a checksum: a mean over the frame catches a decode that produced the right shape
      // and the wrong picture, which a length check cannot.
      mean: frame.samples.reduce((sum, value) => sum + value, 0) / frame.samples.length,
    };
  }, photoId);

  expect(decoded.bytes).toBeGreaterThan(1_000_000);
  expect(decoded.width).toBeGreaterThan(2000);
  expect(decoded.height).toBeGreaterThan(2000);
  expect(decoded.halved).toBe(false);
  expect(decoded.samples).toBe(decoded.width * decoded.height * 3);
  // A frame of zeroes, or of saturated samples, is what a decode that "worked" and read the wrong
  // buffer looks like.
  expect(decoded.mean).toBeGreaterThan(200);
  expect(decoded.mean).toBeLessThan(60000);
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
    if (new URL(request.url()).pathname.endsWith('/prepared')) askedTheServer.push(request.url());
  });
  // The decode's own fall-throughs: a picture that came out of the CPU's PPG rather than RCD looks
  // like this working.
  const declined: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('rawshim: no ')) declined.push(message.text());
  });

  await page.goto(`/photos/${photoId}?edit=1`);

  const panel = page.getByTestId('raw-edit-panel');
  await expect
    .poll(
      async () => {
        const status = await panel.getAttribute('data-status');
        if (status === 'failed') {
          throw new Error(await panel.getByTestId('raw-edit-status').innerText());
        }
        return status;
      },
      { timeout: 170_000 },
    )
    .toBe('live');

  expect(declined).toEqual([]);
  expect(askedTheServer).toEqual([]);

  // The frame reached the editor whole, rather than the editor going live on a header it built
  // for itself: the size is the decode's, and the match is the one the open fitted or was handed.
  const size = await page.getByTestId('raw-edit-size').textContent();
  const [width, height] = (size ?? '0x0').split('x').map(Number);
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(1000);
  await expect(panel).toHaveAttribute('data-matched', 'true');
});

test('reports whether it opened a device, rather than throwing when it cannot', async ({ page }) => {
  await page.goto(`/photos/${photoId}`);

  const device = await page.evaluate(async () => {
    const { LocalDecoder } = await import('/src/features/raw_edit/local_open.ts');
    const opened = await new LocalDecoder().gpu();
    return { opened: opened != null, hasWebGpu: 'gpu' in navigator };
  });

  // The harness runs Chromium with `--enable-unsafe-webgpu`, so a null here is the module failing
  // to request an adapter rather than the browser lacking one - which is the case that silently
  // drops the decode to PPG.
  expect(device.hasWebGpu).toBe(true);
  expect(device.opened).toBe(true);
});

import { type Page, expect, test } from '@playwright/test';
import { EDIT_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, openPhoto, openPhotoId, syncLibrary, waitForSyncSettled } from './helpers';

// Every test here opens a RAW for real - fetch, decode, fit and grade, in the browser, on
// however many cores the rest of the suite has left. Alone that is around ten seconds; the
// first one behind the other eighty-odd tests has measured past the 60s default, and the
// waits below already allow three minutes. Without this they cannot: a test timeout caps
// its own expectations, so the poll reports the *page* as wrong when the machine was slow.
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

test('starts an isolated multithreaded RAW editor worker', async ({ page }) => {
  await page.goto(`/photos/${photoId}?edit=1`);

  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  const available = await page.evaluate(() => navigator.hardwareConcurrency);
  const threads = page.getByTestId('raw-edit-threads');
  await expect(threads).toHaveText(String(Math.max(1, available)));
});

/**
 * The camera match has to be fitted *in the browser*, and no other check can see that it
 * was: without one the grade takes its neutral arm and still produces a plausible HDR
 * frame, correctly tagged, at the right size - just flatter and less saturated than the
 * rendition of the same file. Every byte-level assertion below passes either way.
 *
 * It has been wrong twice, both times numerically rather than structurally: a preview
 * decoded by the browser instead of by `crate::jpeg`, and libblur's wasm SIMD stack blur
 * returning a mostly-black frame (DESIGN 21.1). Both declined the fit in silence.
 */
test('fits the camera match in the browser, as the renditions do', async ({ page }) => {
  await open(page);

  await expect(page.getByTestId('raw-edit-panel')).toHaveAttribute('data-matched', 'true');
});

/**
 * A failure the user can act on, which is worth a test because the failure mode is silent
 * plausibility: the API's envelope nests its message under `error`, so a caller that
 * stringifies one level too high reports "[object Object]" for every kind of failure alike
 * and the page still looks like it is working correctly.
 */
test('says why an id it cannot open failed', async ({ page }) => {
  const missing = '00000000-0000-0000-0000-000000000000';
  // `?edit` skips the viewer's empty state so the editor's own open path is what fails.
  await page.goto(`/photos/${missing}?edit=1`);

  const panel = page.getByTestId('raw-edit-panel');
  await expect(panel).toHaveAttribute('data-status', 'failed');
  await expect(panel).toContainText(`photo not found: ${missing}`);
  await expect(panel).not.toContainText('[object Object]');
});

/**
 * The still route is HDR only because of four bytes, and a PNG that loses them is a
 * valid, ordinary, SDR picture - so every other check downstream of here would still
 * pass. This asserts on the bytes the browser was actually handed.
 *
 * Against a real graded frame rather than a synthetic patch: the encoder is reached
 * through the whole decode-fit-grade path here, so a chunk dropped anywhere along it is
 * caught, and there is nothing to keep in sync with what the editor really emits.
 *
 * Chromium only: production Firefox never takes this route (DESIGN 21.2), and its
 * `Image.decode()` refuses the 16-bit PQ PNG, so forcing `?route=still` there fails the
 * editor before the `<img>` ever sees the bytes this is asserting on.
 */
test('tags the still route PQ, in the bytes the browser receives', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'forced still is a Chromium encoder-byte check');
  await open(page, 'still');

  const stage = page.locator('img.raw-edit__stage');
  const chunks = await stage.evaluate(async (img: HTMLImageElement) => {
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const found: { kind: string; data: number[] }[] = [];
    // Past the 8-byte signature, then length/kind/data/CRC until the file runs out.
    for (let at = 8; at < bytes.length; ) {
      const length = view.getUint32(at);
      const kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      // Only the small ones are worth carrying back; IDAT is the whole picture.
      const data = kind === 'IDAT' ? [] : [...bytes.subarray(at + 8, at + 8 + length)];
      found.push({ kind, data });
      at += 12 + length;
    }
    return found;
  });

  const cicp = chunks.find((c) => c.kind === 'cICP');
  // BT.2020 primaries, the PQ transfer, identity matrix, full range.
  expect(cicp?.data).toEqual([9, 16, 0, 1]);
  // A decoder stops looking for colour once the pixels start.
  expect(chunks.findIndex((c) => c.kind === 'cICP')).toBeLessThan(
    chunks.findIndex((c) => c.kind === 'IDAT'),
  );
  expect(chunks.at(-1)?.kind).toBe('IEND');
});

/**
 * The rewrap route, which is the only one that encodes rather than packs - and the reason
 * libaom is compiled into the wasm module at all. Asserts on the bytes the stage was
 * handed, not on whether this engine can paint them: Gecko composites that file in HDR
 * on Windows only (DESIGN 10.7), and Linux CI often cannot decode it either.
 */
test('encodes the rewrap route as a 10-bit PQ AV1, in the bytes the browser receives', async ({
  page,
}) => {
  await open(page, 'rewrap');

  const stage = page.locator('video.raw-edit__stage');
  const mp4 = await stage.evaluate(async (video: HTMLVideoElement) => [
    ...new Uint8Array(await (await fetch(video.src)).arrayBuffer()),
  ]);
  const bytes = new Uint8Array(mp4);
  const sample = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'av01'];

  const colr = find(bytes, [...sample, 'colr']);
  const view = new DataView(colr.buffer, colr.byteOffset, colr.byteLength);
  expect(String.fromCharCode(...colr.subarray(0, 4))).toBe('nclx');
  // BT.2020 primaries, PQ, BT.2020 non-constant luminance - the CICP a rendition's still
  // is tagged with, since it came out of the same encoder under the same options.
  expect([view.getUint16(4), view.getUint16(6), view.getUint16(8)]).toEqual([9, 16, 9]);

  // Eight bits is a picture Firefox composites SDR, and the difference is one bit of the
  // configuration record's third byte, under `seq_tier_0`. The two below it say 4:2:0,
  // which is not a quality choice either: Firefox decodes 4:4:4 AV1 in software and then
  // will not composite it in HDR.
  const flags = find(bytes, [...sample, 'av1C'])[2] ?? 0;
  expect((flags >> 6) & 1).toBe(1); // high_bitdepth
  expect((flags >> 5) & 1).toBe(0); // twelve_bit, so ten
  expect([(flags >> 3) & 1, (flags >> 2) & 1]).toEqual([1, 1]); // chroma subsampling x and y
});

/**
 * Firefox's production route is the rewrap, not a still. The helper has to be what put
 * the file on the stage - a blob URL of a real MP4 - even where this machine cannot
 * paint it in HDR (Linux; DESIGN 10.7).
 */
test('takes the rewrap route on Firefox and hands the stage an MP4', async ({ page, browserName }) => {
  test.skip(browserName !== 'firefox', 'route selection under test');
  await open(page);

  const stage = page.locator('video.raw-edit__stage');
  await expect(stage).toHaveCount(1);
  const kind = await stage.evaluate(async (video: HTMLVideoElement) => {
    const bytes = new Uint8Array(await (await fetch(video.src)).arrayBuffer());
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    return { type, size: bytes.length };
  });
  expect(kind.type).toBe('ftyp');
  expect(kind.size).toBeGreaterThan(1000);
});

/**
 * The fixture open and graded, on `route` where one is named.
 *
 * Waiting on a delivered frame rather than on `status=live` alone: `live` is set when
 * the RAW has decoded and the camera match has fitted, *before* the first grade returns.
 * A test that proceeds on that alone races the frame - and on a route whose off-screen
 * decode then fails, reports an empty stage where the panel already says why.
 */
async function open(page: Page, route?: 'still' | 'rewrap' | 'track'): Promise<void> {
  const params = new URLSearchParams({ edit: '1' });
  if (route != null) params.set('route', route);
  await page.goto(`/photos/${photoId}?${params}`);

  const panel = page.getByTestId('raw-edit-panel');
  await expect
    .poll(
      async () => {
        const status = await panel.getAttribute('data-status');
        if (status === 'failed') return 'failed';
        if (status !== 'live') return 'waiting';
        const img = page.locator('img.raw-edit__stage');
        if ((await img.count()) > 0) {
          return (await img.evaluate((el: HTMLImageElement) => el.naturalWidth > 0 && el.src !== ''))
            ? 'ready'
            : 'waiting';
        }
        const video = page.locator('video.raw-edit__stage');
        if ((await video.count()) > 0) {
          return await video.evaluate(
            (el: HTMLVideoElement) => el.src !== '' || el.srcObject != null,
          )
            ? 'ready'
            : 'waiting';
        }
        return 'waiting';
      },
      { timeout: 170_000 },
    )
    .toBe('ready');
}

/** The payload of a box, by the path of types leading to it. */
function find(bytes: Uint8Array, path: string[]): Uint8Array {
  // What sits between a box's payload and the child boxes inside it: a version, flags and
  // an entry count for `stsd`, and a VisualSampleEntry's fixed fields for `av01`.
  const fixed: Record<string, number> = { stsd: 8, av01: 78 };
  let [start, end] = [0, bytes.length];
  for (const [depth, type] of path.entries()) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = start;
    let found: [number, number] | null = null;
    while (at + 8 <= end) {
      const size = view.getUint32(at);
      if (size < 8) throw new Error(`a box at ${at} claims ${size} bytes`);
      if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === type) {
        found = [at + 8, at + size];
        break;
      }
      at += size;
    }
    if (found == null) throw new Error(`no ${path.slice(0, depth + 1).join('/')} in the file`);
    [start, end] = depth === path.length - 1 ? found : [found[0] + (fixed[type] ?? 0), found[1]];
  }
  return bytes.subarray(start, end);
}

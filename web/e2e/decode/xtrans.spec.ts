import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { XTRANS_PHOTOS_DIR, XTRANS_PHOTO_NAMES } from '../fixture_library';
import {
  addLibrary,
  editDiagnosticSize,
  editDiagnostics,
  firstPhotoId,
  waitForEditorLive,
} from '../helpers';

// **The only library in the run whose sensor has no 2x2 site.** Every other root here is the Bayer
// fixture under another name, so every other spec exercises RCD and none of them reach the
// demultiplexing at all - a decode that came back black for X-Trans and correct for everything else
// would leave the whole suite green.
//
// What needs a browser, and what does not. The decomposition, the filter, the phase of a lifted
// region and the picture a real RAF becomes are all answered natively and in milliseconds
// (`fixture_tests.rs`, `lslcd.rs`); none of it is repeated here. What is left is the chain: that a
// `.raf` is a file this application imports at all, that the scan builds renditions from one, and
// that the editor opens it on the browser's own adapter. That an edit survives the page is
// `editor/raw_editing.spec.ts`, and nothing about it depends on the sensor.
//
// An open is a real decode of a real RAW in a tab, so this carries the editor spec's timeout.
test.describe.configure({ timeout: 180_000 });

let photoId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  // The assertion, not the setup: settling at one photograph is the import having read a `.raf`,
  // decided it is an original, decoded it and written its renditions. A format missing from the
  // scan set settles at zero and the test below would fail on a photograph that is not there.
  await addLibrary(page, XTRANS_PHOTOS_DIR, { photos: XTRANS_PHOTO_NAMES.length });
  photoId = await firstPhotoId(page, XTRANS_PHOTOS_DIR);
  await page.close();
});

/**
 * The editor opens an X-Trans frame and grades it on a real device.
 *
 * **The one claim in this file that no native test can make.** `an_xtrans_frame_decodes_to_a_picture`
 * runs the same crate against the same file on a Vulkan adapter in-process; what it cannot see is
 * the module compiled to wasm, on whatever adapter the browser hands out, driven by the page. The
 * demultiplexing's shader is new code reaching a second compiler and a second driver here.
 *
 * The size is asserted because a decode that declined returns no frame and the panel reports its
 * failure rather than a stage - and the sensor is 6384 across, so a frame under a thousand pixels
 * is not this photograph however the panel describes itself.
 *
 * It grades through the camera match, which needs the file's own embedded rendering. rawler's RAF
 * decoder could find the embedded JPEG and only ever handed it back decoded, so the trait's default
 * answered `None` and this format had no preview at all - and the match is fitted by pairing pixels
 * against exactly that JPEG. Every Fuji photograph would have rendered down the neutral arm, with
 * nothing reporting it. The attribute is the only place that difference is visible from outside.
 *
 * And the Detail sliders reach this sensor: the panel offers them only where the decode came back
 * with a fit measured off the mosaic, so they say GALOSH ran on a 6x6 period, that the fit crossed
 * back, and that the editor reached the same conclusion the decode did.
 */
test('opens in the editor, grades on the GPU through the camera match, and offers the Detail sliders', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), photoId, PathSegment.edit()));
  await waitForEditorLive(page, 150_000);

  await expect(editDiagnostics(page)).toHaveAttribute('data-adapter', /./);
  const [width, height] = await editDiagnosticSize(page, 'data-size');
  expect(width).toBeGreaterThan(1000);
  expect(height).toBeGreaterThan(1000);
  await expect(editDiagnostics(page)).toHaveAttribute('data-matched', 'true');
  await expect(page.getByRole('slider', { name: 'Luminance', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Colour', exact: true })).toBeVisible();
});

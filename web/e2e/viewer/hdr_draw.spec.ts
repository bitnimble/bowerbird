// An HDR rendition reaching the GPU and drawing a picture, which is the one thing on this
// stage a real browser has to answer for. `frames.spec.ts` owns what arrives when; this owns
// that a render arrives at all, on a library that builds them HDR.
//
// **What it catches**, all of them silent pictures rather than errors: the rendition never
// built, the stage drawing a held neighbour instead of the photograph, `paintExtended`
// declining and falling to the 2D context, and a canvas the GPU took but never painted.
//
// **What it does not catch, measured rather than assumed:** the depth scaling in
// `Colour::depth`. Running this against a deliberately wrong divisor - 1 where a twelve-bit
// frame wants 4 - moves the drawn mean from 41.97 to 44.51 and the tone count from 12 to 11,
// which no honest threshold separates. The samples reaching the shader are right (Chromium's
// `copyTo` matches dav1d's plane values exactly, and a ten-bit file's are 4.0x smaller), so
// what is unexplained is the shader's response to them through an extended-range canvas
// composited on an SDR headless display. `planar_layout.test.ts` pins the divisor this picks;
// the arithmetic that consumes it is not covered here, and a stronger assertion would need a
// reference frame to compare against rather than a threshold.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { API_URL, HDR_PHOTOS_DIR, libraryDataDir } from '../fixture_library';
import {
  gotoPhoto,
  photoStage,
  recordCanvasContexts,
  setRenditionSource,
  setViewerRendition,
  shownFrame,
  useLibrary,
} from '../helpers';

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, HDR_PHOTOS_DIR);
});

// Where this library's HDR renditions land. `rendition_hdr` decides the directory, so it is
// read off the library rather than assumed - and a library that came back SDR would send this
// spec looking in the right place for the wrong claim.
async function hdrRendition(request: APIRequestContext, photoId: string): Promise<string> {
  const libraries = (await (await request.get(`${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`)).json()) as {
    id: string;
    root_path: string;
    rendition_hdr: boolean;
  }[];
  const library = libraries.find((l) => l.root_path === HDR_PHOTOS_DIR);
  expect(library, 'the HDR library is registered').toBeDefined();
  expect(library!.rendition_hdr, 'the library renders HDR').toBe(true);
  return path.join(libraryDataDir(library!.id), 'renditions', 'full-hdr', `${photoId}.avif`);
}

test('an HDR rendition reaches the GPU and draws a photograph', async ({ page }) => {
  // A real render of the RAW, which the 60s default expires in the middle of - the failure
  // then reads as a timeout rather than as the wait it is. Past the sum of the two waits
  // below rather than equal to it, so a slow run fails on whichever of them it actually
  // outran and says which; a budget of exactly 180 + 60 leaves the navigation, the screenshot
  // and the decode with none, and kills a correct run at the least informative place.
  test.setTimeout(320_000);
  const contexts = await recordCanvasContexts(page);

  await setRenditionSource(page, HDR_PHOTOS_DIR, 'render');
  // `rendition_hdr` is on by default, so a library that renders renders HDR; the viewer has
  // to be pointed at that rendition rather than at the camera's JPEG for the stage to draw it.
  await setViewerRendition(page.request, 'full');

  const photoId = await gotoPhoto(page, HDR_PHOTOS_DIR);

  // The canvas goes ready on whatever the stage has - a grid tile while the render runs - so
  // the file has to arrive before anything is asserted about the picture.
  const rendition = await hdrRendition(page.request, photoId);
  await expect.poll(() => existsSync(rendition), { timeout: 180_000 }).toBe(true);

  // Opened by id rather than reloading whatever was showing, and its file matched by id too: the library
  // holds two identical frames, so which one "the first photo" resolves to is not stable across
  // a reload - and the stage keeps a canvas per held neighbour, whose render has not landed. A
  // picture asserted against either of those is a blank canvas for reasons of its own.
  const render = `${route(PathSegment.image())}/${photoId}${route(PathSegment.renditions(), 'full')}`;
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(render)) fetched.push(request.url());
  });
  await page.goto(route(PathSegment.photos(), photoId));
  const shown = shownFrame(page);
  await expect(shown).toHaveAccessibleName(/Rendered RAW$/, { timeout: 60_000 });
  await expect(photoStage(page)).not.toContainText('Rendering');

  // A canvas holds one kind of context for its whole life, and the stage's are drawn on the GPU
  // worker, which is the one place that can say which kind each one took.
  expect(await contexts(), 'the GPU path drew it, rather than the 2D fallback').not.toContain('2d');
  expect(await contexts()).toContain('webgpu');

  // **Through a screenshot, because a WebGPU canvas cannot be read by script after the task
  // that drew it.** Measured in this browser: `drawImage` and `createImageBitmap` both hand
  // back transparent black on a canvas whose content the compositor is showing perfectly well.
  // The screenshot is the compositor's own capture, and it is decoded back inside the page so
  // that the browser's PNG decoder does that part rather than this file.
  const shot = await shown.screenshot();
  const drawn = await page.evaluate(async (encoded: string) => {
    const blob = await (await fetch(`data:image/png;base64,${encoded}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const probe = document.createElement('canvas');
    probe.width = 64;
    probe.height = 64;
    const flat = probe.getContext('2d')!;
    flat.drawImage(bitmap, 0, 0, 64, 64);
    const { data } = flat.getImageData(0, 0, 64, 64);
    // Luma per sample, and how many sixteenths of the range the picture occupies. A blown draw
    // and a black one both collapse to one bucket; a photograph does not.
    const buckets = new Set<number>();
    let total = 0;
    let counted = 0;
    for (let at = 0; at < data.length; at += 4) {
      // Only where the picture is: a letterboxed element would otherwise average mostly
      // transparent black, which moves for reasons that are not the picture's.
      if (data[at + 3]! < 128) continue;
      const luma = 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!;
      buckets.add(Math.floor(luma / 16));
      total += luma;
      counted++;
    }
    return { mean: total / counted, buckets: buckets.size };
  }, shot.toString('base64'));

  // Not at either rail, which is what an undrawn canvas and a blown one look like.
  expect(drawn.mean, 'the picture is not empty or blown out').toBeGreaterThan(8);
  expect(drawn.mean).toBeLessThan(240);
  // And a photograph rather than a flat field, which every failure above leaves behind even
  // when the mean happens to land in range.
  expect(drawn.buckets, 'the picture holds a range of tones').toBeGreaterThan(3);

  // The file the stage actually fetched, decoded again here: the depth and transfer the
  // encoder wrote, which is what sends it down the planar path rather than the import. Pinned
  // off the URL the stage asked for rather than off the one this spec would have built, so a
  // stage showing a grid tile or a stale rendition fails here rather than passing above.
  const source = fetched.at(-1) ?? '';
  const format = await page.evaluate(async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) return `fetch ${response.status}`;
    const Decoder = (globalThis as unknown as {
      ImageDecoder?: new (init: unknown) => { decode(): Promise<{ image: VideoFrame }> };
    }).ImageDecoder;
    if (Decoder == null) return 'no ImageDecoder';
    const { image } = await new Decoder({ data: await response.arrayBuffer(), type: 'image/avif' }).decode();
    return `${String(image.format)} ${String(image.colorSpace.transfer)} full=${String(image.colorSpace.fullRange)}`;
  }, source);
  expect(format, 'the stage drew the twelve-bit PQ rendition').toBe('I420P12 pq full=false');
});

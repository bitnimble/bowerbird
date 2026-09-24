// Which file the viewer is showing: choosing one, caching it, forcing past the
// cache, and rebuilding one that has gone missing. The pictures these produce are
// `frames.spec.ts`; this is about the files behind them.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { orientationOfAvif } from 'avif-hdr-video';
import { PathSegment, route } from '../../../src/schemas/route';
import { API_URL, PHOTO_NAMES, RENDITION_PHOTOS_DIR, libraryDataDir } from '../fixture_library';
import {
  bulkAction,
  openLibrary,
  openPhoto,
  openPhotoId,
  photoAction,
  photoStage,
  renditionDetails,
  selectPhoto,
  setRenditionSource,
  setViewerRendition,
  showMetadata,
  shownFilename,
  shownFrame,
  recordCanvasContexts,
  stepZoom,
  tiles,
  useLibrary,
  viewMaxQuality,
} from '../helpers';

// In order, and the order is the point: these walk one library from serving the
// camera's JPEG to rendering the RAW, and each reads the state the one before it
// left.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, RENDITION_PHOTOS_DIR, { viewerRendition: 'Embedded JPEG' });
});

// Where this library's renditions land. Generated files live outside every
// library root now (§3) and the directory is keyed by the library's id, so the
// path is asked for rather than built from the root the spec already holds.
// The large renditions are filed under `<rendition>-hdr` when the library builds
// them in HDR, so the directory is read off the library rather than assumed.
async function renditionPath(request: APIRequestContext, rendition: string, photoId: string): Promise<string> {
  const libraries = (await (await request.get(`${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`)).json()) as {
    id: string;
    root_path: string;
    rendition_hdr: boolean;
  }[];
  const library = libraries.find((l) => l.root_path === RENDITION_PHOTOS_DIR);
  expect(library, 'the rendition library is registered').toBeDefined();
  const dir = library!.rendition_hdr ? `${rendition}-hdr` : rendition;
  return path.join(libraryDataDir(library!.id), 'renditions', dir, `${photoId}.avif`);
}

// A photo can be marked processed while its renditions are gone: a failed build,
// a half-finished copy, a pruned data directory. Nothing would ever queue it
// again, so the detail view has to notice and build the one it needs rather than
// sit on "no rendition yet".
//
// Rebuilding must be the *missing* rendition and not simply a reprocess: that
// writes the grid tile, which is not what the viewer asked for, so a library
// that renders would ask again on every paint and never settle.
test('opening a photo whose rendition is gone builds that rendition back', async ({ page }) => {
  // Two real renders of the RAW, and the 60s default expires mid-poll: the
  // failure then reads as a timeout rather than as the wait it is.
  test.setTimeout(240_000);
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, RENDITION_PHOTOS_DIR);
  await openPhoto(page);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  const photoId = openPhotoId(page);

  // A library that serves the camera's JPEG cannot lose its rendition - those bytes
  // come out of a RAW that is still on disk - so the gap only exists for one that
  // renders. Switching it is also what makes the reload open at the full-size
  // rendition rather than at the JPEG.
  await page.goto(route(PathSegment.settings()));
  await setRenditionSource(page, RENDITION_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Rendered RAW');
  const full = await renditionPath(page.request, 'full', photoId);

  await page.goto(route(PathSegment.photos(), photoId));
  await expect.poll(() => existsSync(full), { timeout: 90_000 }).toBe(true);
  rmSync(full, { force: true });

  await page.reload();
  // The 404 is what starts the build, so while it runs the stage says a rendition is being
  // made. It used to say "no rendition yet" for the whole render - the flag the pill is
  // raised by was set only by a rendition the reader had chosen, and never by the one the
  // photo opened at, which is the common way to meet a photo that has none.
  await expect(photoStage(page).getByRole('status')).toContainText('Rendering');
  await expect(photoStage(page).getByText('Rendition not ready')).toHaveCount(0);

  await expect.poll(() => existsSync(full), { timeout: 90_000 }).toBe(true);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  // Off the viewport, which is always there: the pill itself is unmounted when there is
  // nothing to say, and an assertion against a locator that matches nothing fails rather
  // than passing - while `toBeHidden` on one passes whatever it is named.
  await expect(photoStage(page)).not.toContainText('Rendering');
});

// The point of caching the renditions is that switching back to one already seen
// costs nothing.
test('a chosen rendition is cached on disk, and survives a tile rebuild', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, RENDITION_PHOTOS_DIR);
  await openPhoto(page);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  const photoId = openPhotoId(page);

  const showRendition = (label: string): Promise<void> => photoAction(page, 'Rendition', label, { exact: true });

  const renditionPanel = renditionDetails(page);
  await showMetadata(page);
  await showRendition('Rendered RAW');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });
  // Off the viewport, which is always there: the pill itself is unmounted when there is
  // nothing to say, and an assertion against a locator that matches nothing fails rather
  // than passing - while `toBeHidden` on one passes whatever it is named.
  await expect(photoStage(page)).not.toContainText('Rendering');
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  // The photo's own renditions are the embedded rendition, so only the render had
  // to be built and stored; the embedded one is served from what already existed.
  const cached = await renditionPath(page.request, 'full', photoId);
  expect(existsSync(cached)).toBe(true);

  // Every rendition stays on offer whichever one is showing, the camera's JPEG
  // included: comparing a render against it is a reason to step back down.
  //
  // And stepping between two that are already there costs nothing. Counted rather than
  // timed, because what went wrong was a request rather than a delay: every choice asked
  // the server to build - the camera's JPEG, which is never built at all, included - and
  // waited on a detail fetch before it would swap. So the render flashed "Rendering" over
  // itself, the JPEG took a round trip to appear, and both views were in the DOM the whole
  // time.
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`${route(PathSegment.api(), PathSegment.photos())}/`)) {
      asked.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  await showRendition('Embedded JPEG');
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });
  // Off the viewport, which is always there: the pill itself is unmounted when there is
  // nothing to say, and an assertion against a locator that matches nothing fails rather
  // than passing - while `toBeHidden` on one passes whatever it is named.
  await expect(photoStage(page)).not.toContainText('Rendering');
  await showRendition('Rendered RAW');
  // The picker is three keys and a menu buried in the bar, so the stage names what the
  // reader has just been given. Both are built by now, so this is the swap and not a wait.
  await expect(photoStage(page).getByRole('status')).toContainText('Rendered RAW');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });
  // Off the viewport, which is always there: the pill itself is unmounted when there is
  // nothing to say, and an assertion against a locator that matches nothing fails rather
  // than passing - while `toBeHidden` on one passes whatever it is named.
  await expect(photoStage(page)).not.toContainText('Rendering');
  // Nothing at all: not the build, and not the detail fetch that used to be awaited before
  // the swap was allowed to happen even when there was no build to learn anything about.
  expect(asked, 'a swap between two renditions already built asks the server for nothing').toEqual([]);

  // And not the frames either. Both renditions have now decoded, and both stay mounted, so
  // going back to one is an opacity change on an element that never left the page. Marked
  // rather than counted or timed: a frame replaced by an identical one passes every
  // assertion about the source, and is exactly the fetch and the decode this avoids.
  //
  // This photograph's own picture, not every frame on the stage: the neighbours either side
  // are pictures of their own, and whether one is up here depends on whether that photo has
  // a render yet - which this test neither arranges nor is about.
  const mounted = photoStage(page).getByRole('img', { name: `${await shownFilename(page)}, `, includeHidden: true });
  await expect(mounted, 'both renditions of the photo on screen are mounted').toHaveCount(2);
  await mounted.evaluateAll((frames) => frames.forEach((frame) => frame.setAttribute('data-held', '1')));

  await showRendition('Embedded JPEG');
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });
  await showRendition('Rendered RAW');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });

  await expect(shownFrame(page)).toHaveAttribute('data-held', '1');
  await expect(photoStage(page).locator('canvas[data-held]'), 'both frames survive the swaps').toHaveCount(2);

  // Both are up, so the panel can still say what the one on screen measured. A flip decodes
  // nothing, so nothing reports a size on it: the dimensions have to come from what that
  // frame measured when it first arrived.
  await expect(renditionPanel).not.toContainText('loading');

  // The grid's rebuild is the grid tile and nothing else. It used to queue both
  // stages, which had the run sweep every rendition it did not itself write - so
  // regenerating a rendition deleted the render the viewer was holding, and the
  // next look paid for it again.
  // Out the way the viewer offers rather than through the sidebar, which is hidden
  // behind the photograph while one is open.
  await page.keyboard.press('Escape');
  await selectPhoto(page);
  await bulkAction(page, 'Rebuild thumbnails');
  await expect(page.getByText(/Queued 1 thumbnail to rebuild/)).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000); // the sweep that must not happen is fire-and-forget
  expect(existsSync(cached)).toBe(true);
});

// Switching between the camera's JPEG and a render is the comparison the detail
// view exists for, so it is a keystroke rather than a trip through the menu.
test('i and o switch between the camera JPEG and the render, and the cache can be forced past', async ({ page }) => {
  // A forced rebuild is a real render of the RAW, not a cache hit.
  test.setTimeout(240_000);
  await page.goto(route(PathSegment.settings()));
  // Named here rather than inherited: re-rendering is offered only where the library
  // has a render of its own to remake.
  await setRenditionSource(page, RENDITION_PHOTOS_DIR, 'Rendered RAW');
  await openLibrary(page, RENDITION_PHOTOS_DIR);
  await openPhoto(page);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  const photoId = openPhotoId(page);
  const versioned = `${route(PathSegment.image())}/${photoId}${route(PathSegment.renditions(), 'full')}?v=`;
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(versioned)) fetched.push(request.url());
  });

  const renditionPanel = renditionDetails(page);
  await showMetadata(page);
  await page.keyboard.press('o');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('i');
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });

  // The file is the cache, so nothing rebuilds a rendition once it exists. This
  // is the escape hatch for working on the pipeline: the same choice, but the
  // stored copy is dropped first.
  const cached = await renditionPath(page.request, 'full', photoId);
  const before = statSync(cached).mtimeMs;
  const fetchedBefore = new Set(fetched);
  await photoAction(page, 'Actions', 'Rebuild rendition');
  // A build made on request is covered over the photograph while it runs, so the frame
  // underneath is not mistaken for the one that was asked for. Asserted here rather than on
  // a plain choice, which is a swap between files that already exist and covers nothing.
  await expect(photoStage(page).getByRole('status')).toContainText('Rendering');
  await expect(photoStage(page)).not.toContainText('Rendering', { timeout: 120_000 });
  await expect.poll(() => statSync(cached).mtimeMs, { timeout: 120_000 }).toBeGreaterThan(before);

  // And the reader is left where they were: the render was remade under them, not
  // put on screen.
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible();
  // Focus back on the page: the menu's trigger keeps it after the item is picked, and
  // eats letter keys as typeahead.
  await page.getByRole('group', { name: 'Photo controls' }).getByText(await shownFilename(page)).click();
  await page.keyboard.press('o');
  await expect(renditionPanel.getByText('Rendered RAW')).toBeVisible({ timeout: 120_000 });

  // Rewriting the file is only half of it: the URL is stable, so the stage would
  // go on showing the copy it has already decoded. Nothing announces a build made
  // outside the processing queue, so the client that asked for it says so itself,
  // and the version lands on this photo alone.
  await expect(shownFrame(page)).toHaveAccessibleName(/Rendered RAW$/, { timeout: 60_000 });
  await expect
    .poll(() => fetched.filter((url) => !fetchedBefore.has(url)), { message: 'the rebuilt render is fetched at a URL of its own', timeout: 60_000 })
    .not.toEqual([]);
});

// AVIF decodes natively in every browser, which is why it replaced the JXL that needed a wasm
// module and a PNG transcode first (§10.5).
test('the max-quality rendition is served as a full-resolution AVIF', async ({ page }) => {
  test.setTimeout(240_000);
  await viewMaxQuality(page, RENDITION_PHOTOS_DIR);

  const shown = shownFrame(page);
  await expect(shown).toHaveAccessibleName(/Rendered RAW \(max quality\)$/);
  // Past 3840, which is the rendition this replaced: the canvas is the decode, capped at
  // `DECODE_CAP`, so a native-resolution file lands at 4096 along its long edge where a
  // 3840-edge one lands at exactly 3840.
  expect(await shown.evaluate((frame: HTMLCanvasElement) => Math.max(frame.width, frame.height))).toBeGreaterThan(3840);
});

// Regression: which rendition the viewer shows came from the photo's detail, so
// a reader set to the camera's JPEG in a library that renders got the render
// first - fetched, decoded and painted with its lens distortion still in - and
// then swapped out the moment the setting could be applied. Every step through
// the cull paid for both files.
test('a reader set to the camera JPEG never loads the render', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));

  await page.goto(route(PathSegment.settings()));
  await setRenditionSource(page, RENDITION_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Embedded JPEG');
  await openLibrary(page, RENDITION_PHOTOS_DIR);
  await openPhoto(page);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  // Warmed at the rendition on screen rather than the library's, or the step
  // below arrives cold and shows the stage background while it fetches.
  const openId = openPhotoId(page);
  await expect.poll(() => requested.some((url) => url.includes(route(PathSegment.renditions(), 'embedded')) && !url.includes(openId))).toBe(true);
  const openName = await shownFilename(page);

  requested.length = 0;
  await page.getByRole('button', { name: 'Next photo' }).click();
  const nextId = openPhotoId(page);
  const nextName = PHOTO_NAMES.find((name) => name !== openName);
  await expect(shownFrame(page)).toHaveAccessibleName(`${nextName}, Embedded JPEG`, { timeout: 60_000 });
  // Named rather than "any rendition": the camera's JPEG is asked for by the same route as
  // everything else now, and it is the render this reader must never be made to wait for.
  expect(requested.filter((url) => url.includes(route(nextId, PathSegment.renditions(), 'full')))).toEqual([]);
});

// "Last used per photo" is the same question as the setting above, asked per
// photo rather than once: the answer has to be on the row for the same reason,
// or reopening a photo paints the library's default while the detail carrying
// the reader's own choice is still in flight.
test('a photo reopens at the rendition it was last read in, without the library default first', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));

  await page.goto(route(PathSegment.settings()));
  await setRenditionSource(page, RENDITION_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Last used per photo');
  await openLibrary(page, RENDITION_PHOTOS_DIR);
  await openPhoto(page);
  const photoId = openPhotoId(page);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  // Read it in the camera's JPEG, which this library does not default to.
  await page.keyboard.press('i');
  await showMetadata(page);
  const renditionPanel = renditionDetails(page);
  await expect(renditionPanel.getByText('Embedded JPEG')).toBeVisible({ timeout: 60_000 });

  await page.keyboard.press('Escape');
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);
  requested.length = 0;
  await openPhoto(page);

  await expect(shownFrame(page)).toHaveAccessibleName(/Embedded JPEG$/, { timeout: 60_000 });
  expect(requested.filter((url) => url.includes(route(photoId, PathSegment.renditions(), 'full')))).toEqual([]);
});

test('viewer rotation turns embedded display and tags full AVIF without moving coded pixels', async ({ page }) => {
  test.setTimeout(180_000);
  const contexts = await recordCanvasContexts(page);
  await page.goto(route(PathSegment.settings()));
  await setRenditionSource(page, RENDITION_PHOTOS_DIR, 'Rendered RAW');
  await setViewerRendition(page, 'Embedded JPEG');
  await openLibrary(page, RENDITION_PHOTOS_DIR);
  await openPhoto(page);
  const photoId = openPhotoId(page);
  const embedded = photoStage(page).getByRole('img', { name: /Embedded JPEG$/ });
  await expect(embedded).toBeVisible({ timeout: 60_000 });
  const before = await embedded.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);

  await photoAction(page, 'View', 'Rotate right');
  await expect.poll(async () => {
    const response = await page.request.get(route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits()));
    const state = (await response.json()) as { doc: { rotate: number } };
    return state.doc.rotate;
  }).toBe(90);
  await expect.poll(() => embedded.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]))
    .toEqual([before[1], before[0]]);

  await photoAction(page, 'Rendition', 'Rendered RAW', { exact: true });
  const full = await renditionPath(page.request, 'full', photoId);
  await expect.poll(() => existsSync(full) ? orientationOfAvif(new Uint8Array(readFileSync(full))) : null, { timeout: 90_000 }).toBe(90);
  const rendered = photoStage(page).getByRole('img', { name: /Rendered RAW$/ });
  await expect(rendered).toBeVisible({ timeout: 60_000 });
  const shown = await rendered.evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.height);
  expect(Math.abs(shown - before[1]! / before[0]!)).toBeLessThan(0.01);

  await photoAction(page, 'Rendition', 'Rendered RAW (max quality)', { exact: true });
  await expect(photoStage(page).getByRole('img', { name: /\(max quality\)$/ })).toBeVisible({ timeout: 90_000 });
  const unzoomed = (await contexts()).length;
  await stepZoom(page);
  await stepZoom(page);
  // The zoom's own canvas, drawn on the GPU like the frame under it.
  await expect.poll(async () => (await contexts()).slice(unzoomed), { timeout: 30_000 }).toContain('webgpu');
  expect(await contexts()).not.toContain('2d');
});

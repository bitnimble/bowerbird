// What is actually on the stage, frame by frame: the neighbours held ready either side
// of the one on screen, the picture held while a cold one decodes, and the animation a
// step arrives with. Everything here is about the moment of a swap, which is why so much
// of it samples every animation frame rather than reading the DOM once.
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { FRAME_PHOTOS_DIR, PHOTO_NAMES } from '../fixture_library';
import {
  FIRST_FRAME,
  gotoPhoto,
  libraryPhotos,
  openPhotoId,
  photoStage,
  renditionDetails,
  setRenditionSource,
  setViewerRendition,
  showMetadata,
  shownFilename,
  shownFrame,
  useLibrary,
} from '../helpers';

// In order: the tests about the step want a library still serving the camera's JPEG, and
// the ones after them re-point it at a render.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, FRAME_PHOTOS_DIR);
});

interface Sample {
  id: string;
  /** The accessible name of the frame on screen, '' for none. */
  frame: string;
}

// Runs in the page, so it cannot reach the helpers.
function sampleShownFrame(key: string): void {
  const samples: Sample[] = [];
  (window as unknown as Record<string, Sample[]>)[key] = samples;
  const tick = (): void => {
    const frames = document.querySelectorAll('[role="region"][aria-label="Photo"] [role="img"]');
    const shown = [...frames].find((frame) => frame.closest('[aria-hidden="true"]') == null);
    samples.push({
      id: location.pathname.split('/').pop() ?? '',
      frame: shown?.getAttribute('aria-label') ?? '',
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function samplesOf(page: Page, key: string): Promise<Sample[]> {
  return page.evaluate((name) => (window as unknown as Record<string, Sample[]>)[name] ?? [], key);
}

// Parents of the frames, which carry the zoom, the pan and a step's fade.
function pictures(page: Page): Locator {
  return photoStage(page).locator('canvas[role="img"]').locator('..');
}

const ARRIVING_SCALE = '0.975';

interface StepFrame {
  /** How much of the photograph stepped to is drawn, and of the one stepped away from. */
  arriving: number;
  leaving: number;
  /** The size the one stepped to is being brought in from, while it is. */
  from: string | null;
  /** The two are added to each other, and to nothing behind them. */
  summed: boolean;
}

interface StepSampling {
  stepFrames: StepFrame[];
  stepSampler: number;
}

// Runs in the page, so it cannot reach the helpers. The picture on screen is the one a step
// will leave, and the one named is the neighbour it will bring in.
function sampleStep(arrivingName: string): void {
  const seen = (picture: Element | null | undefined): number => {
    if (picture == null) return 0;
    const frame = [...picture.querySelectorAll('canvas[role="img"]')].reduce(
      (most, each) => Math.max(most, Number(getComputedStyle(each).opacity)),
      0,
    );
    return Number(getComputedStyle(picture).opacity) * frame;
  };
  const stage = document.querySelector('[role="region"][aria-label="Photo"]');
  const frames = [...(stage?.querySelectorAll('canvas[role="img"]') ?? [])];
  const leaving = frames.find(
    (frame) => frame.getAttribute('aria-hidden') === 'false',
  )?.parentElement;
  const arriving = frames.find((frame) =>
    frame.getAttribute('aria-label')?.startsWith(`${arrivingName}, `),
  )?.parentElement;
  const sampling = window as unknown as StepSampling;
  const samples: StepFrame[] = [];
  sampling.stepFrames = samples;
  const mine = (sampling.stepSampler ?? 0) + 1;
  sampling.stepSampler = mine;
  const tick = (): void => {
    if (sampling.stepSampler !== mine) return;
    const [entrance] = arriving?.getAnimations() ?? [];
    const first = (entrance?.effect as KeyframeEffect | undefined)?.getKeyframes()[0];
    samples.push({
      arriving: seen(arriving),
      leaving: seen(leaving),
      from: (first?.scale as string | undefined) ?? null,
      summed:
        stage != null &&
        getComputedStyle(stage).isolation === 'isolate' &&
        [arriving, leaving].every(
          (picture) => picture != null && getComputedStyle(picture).mixBlendMode === 'plus-lighter',
        ),
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Steps onto the neighbour named, and hands back every frame from the press until the
// stage is at rest again.
async function stepOnto(page: Page, key: string, name: string): Promise<StepFrame[]> {
  // Drawn and kept, not merely mounted: a neighbour still decoding is stood in for by the
  // photo being left, and one that takes long enough leaves the stage empty.
  await expect(
    photoStage(page).getByRole('img', { name: `${name}, `, includeHidden: true }),
  ).toHaveCSS('will-change', 'opacity', { timeout: 60_000 });
  await page.evaluate(sampleStep, name);
  await page.keyboard.press(key);
  await expect(shownFrame(page)).toHaveAccessibleName(new RegExp(`^${name}, `), {
    timeout: 60_000,
  });
  const sampled = (): Promise<StepFrame[]> =>
    page.evaluate(() => (window as unknown as StepSampling).stepFrames);
  await expect
    .poll(async () => {
      const last = (await sampled()).at(-1);
      return last != null && last.arriving === 1 && last.from == null && !last.summed;
    })
    .toBe(true);
  return sampled();
}

test('frames have their fitted dimensions before they are handed to the GPU worker', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const handovers = new WeakMap<HTMLCanvasElement, readonly [number, number]>();
    (window as unknown as { canvasHandovers: typeof handovers }).canvasHandovers = handovers;
    const transfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function (
      this: HTMLCanvasElement,
    ): OffscreenCanvas {
      handovers.set(this, [this.width, this.height]);
      return transfer.call(this);
    };
  });
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible(FIRST_FRAME);
  const openName = await shownFilename(page);
  const otherName = PHOTO_NAMES.find((name) => name !== openName);
  const dimensions = (): Promise<{
    handed: readonly [number, number] | undefined;
    drawn: number[];
  }> =>
    shownFrame(page).evaluate((frame) => {
      if (!(frame instanceof HTMLCanvasElement))
        throw new Error('The photo is not drawn on a canvas');
      const { canvasHandovers } = window as unknown as {
        canvasHandovers: WeakMap<HTMLCanvasElement, readonly [number, number]>;
      };
      return { handed: canvasHandovers.get(frame), drawn: [frame.width, frame.height] };
    });
  const samples: Awaited<ReturnType<typeof dimensions>>[] = [];

  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(key);
    await expect(shownFrame(page)).toHaveAccessibleName(
      new RegExp(`^${key === 'ArrowRight' ? otherName : openName}, `),
      FIRST_FRAME,
    );
    await expect.poll(async () => (await dimensions()).drawn).not.toEqual([300, 150]);
    samples.push(await dimensions());
  }
  for (const { handed, drawn } of samples) {
    expect(drawn[0]).toBeGreaterThan(300);
    expect(drawn[1]).toBeGreaterThan(150);
    expect(handed).toEqual(drawn);
  }
});

// A frame that arrives around the moment the held one is dropped still goes up.
//
// Every other check here has the image arrive instantly, so nothing covered a
// decode landing near the cap at all. It does NOT reproduce the commit-order race
// the guard in `setPainted` is for - that needs the promotion to commit between
// the timer firing and the effect that would have cancelled it, which an idle
// machine almost never does. Treat this as coverage of slow decodes, not of that.
test('a frame that lands as the held one is dropped is still shown', async ({ page }) => {
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  // Delays either side of the 100ms cap.
  for (const delay of [80, 105, 130]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route(new RegExp(`${route(PathSegment.image())}/`), async (intercepted) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      await intercepted.continue();
    });
    await page.getByRole('button', { name: 'Next photo' }).click();
    await expect(shownFrame(page), `delay ${delay}ms`).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Previous photo' }).click();
    await expect(shownFrame(page), `delay ${delay}ms, back`).toBeVisible({ timeout: 20_000 });
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('the previous photo is held for a beat and then dropped, however slow the next one is', async ({
  page,
}) => {
  // Installed before the photo is opened, so the neighbours it then holds are as slow as
  // everything else and the frame stepped to is genuinely still coming. The hold is for a
  // photograph the stage was *not* holding, and with these answering at once there is no
  // such photograph to step to.
  await page.route(new RegExp(`${route(PathSegment.image())}/`), async (intercepted) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await intercepted.continue();
  });

  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  const openId = openPhotoId(page);
  const openName = await shownFilename(page);

  // Sampled every frame rather than read once after the click: the hold is capped
  // in the tens of milliseconds, which no round trip can be relied on to land in.
  await page.evaluate(sampleShownFrame, 'stageSamples');

  await page.getByRole('button', { name: 'Next photo' }).click();
  await page.waitForTimeout(1000);
  const after = (await samplesOf(page, 'stageSamples')).filter((s) => s.id !== openId);

  // The frame before stays up across the route change: dropping it first turns the arrival
  // of a photograph the stage was not holding into a blink of stage background.
  expect(after.some((s) => s.frame.startsWith(`${openName}, `))).toBe(true);
  // And only for a beat. The panels beside it already describe the photo in the
  // URL, so a held frame that outlasts its cap is the wrong picture rather than a
  // smooth step - and this one's own image is still three seconds out.
  expect(after.at(-1)?.frame).toBe('');

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
});

// Regression: the neighbours held either side are full-size images stacked over the
// frame, so the pointer landed on one of them. Chromium honours the -webkit-user-drag
// they inherit; Firefox does not, and started an image drag that cancelled the pointer
// capture, so a zoomed photo could not be panned at all.
test('the neighbours held either side never take the pointer from the frame', async ({ page }) => {
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  // Both neighbours are pictures of this stage, so the first photo of the collection has
  // one of them beside itself. Counted rather than merely "not one", which a stage
  // rendering nothing at all also satisfies.
  await expect(pictures(page)).toHaveCount(2, { timeout: 60_000 });

  const hit = await photoStage(page).evaluate((vp) => {
    const box = vp.getBoundingClientRect();
    const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return el?.getAttribute('role') === 'img' && el.getAttribute('aria-hidden') === 'false'
      ? el.getAttribute('aria-label')
      : null;
  });
  expect(hit).toBe(await shownFrame(page).getAttribute('aria-label'));
});

// Regression: a fully transparent element is never rasterised, so the frame
// revealed on promotion had no raster and the browser needed a frame or two to
// build one. Dropped in the same commit, the outgoing frame left the stage
// background showing through for exactly that long, on every swap. Sampling
// which frame is on screen cannot see it: the DOM is already correct, so
// what this pins is the overlap that covers the gap.
test('the frame being replaced is held opaque under its replacement for a beat', async ({
  page,
}) => {
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  // Every frame, because the hold is a few frames long and no round trip can be
  // relied on to land inside it.
  await page.evaluate(() => {
    const counts: number[] = [];
    (window as unknown as { opaque: number[] }).opaque = counts;
    const tick = (): void => {
      const frames = document.querySelectorAll(
        '[role="region"][aria-label="Photo"] canvas[role="img"]',
      );
      counts.push([...frames].filter((frame) => getComputedStyle(frame).opacity === '1').length);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.keyboard.press('o');
  await showMetadata(page);
  await expect(renditionDetails(page).getByText('Rendered RAW')).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1000);

  const counts = await page.evaluate(() => (window as unknown as { opaque: number[] }).opaque);
  // Two frames up at once across the swap, and back to one after it: a hold that
  // never ends would leave the photo before this one on the stage.
  expect(counts.filter((n) => n === 2).length).toBeGreaterThan(0);
  expect(counts.at(-1)).toBe(1);
});

test('stepping to a neighbour fades it in over the photo it replaces', async ({ page }) => {
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  // Opening a photo is not a step, so the first picture just appears.
  expect(
    await pictures(page).evaluateAll((all) =>
      all.filter((picture) => picture.getAnimations().length > 0),
    ),
  ).toHaveLength(0);

  const shown = shownFrame(page).locator('..');
  const openName = await shownFilename(page);
  const otherName = PHOTO_NAMES.find((name) => name !== openName);
  if (otherName == null) throw new Error('the library has no second photo');

  const frames = await stepOnto(page, 'ArrowRight', otherName);
  expect(frames.some((frame) => frame.from === ARRIVING_SCALE)).toBe(true);
  // The one being left is drawn for as long as the other is short of whole, and neither
  // goes back on itself, so the one arriving is never up whole before it has faded in.
  for (const frame of frames) expect(frame.arriving + frame.leaving).toBeCloseTo(1, 1);
  const arrivals = frames.map((frame) => frame.arriving);
  expect(arrivals).toEqual([...arrivals].sort((a, b) => a - b));
  // Added together, two part-drawn photographs are one whole one. Laid one over the other
  // they let the stage through between them, and the picture dips towards it mid-fade.
  const partway = frames.filter((frame) => frame.arriving > 0 && frame.arriving < 1);
  expect(partway.length).toBeGreaterThan(0);
  expect(partway.every((frame) => frame.summed)).toBe(true);

  const back = await stepOnto(page, 'ArrowLeft', openName);
  expect(back.some((frame) => frame.from === ARRIVING_SCALE)).toBe(true);

  // A rendition swap holds the photo, and the renditions of a photograph are one
  // picture: the second file mounts inside the picture already on screen, which
  // leaves the animated element untouched. That is why swapping cannot fade -
  // there is no new element to replay an entrance on.
  await shown.evaluate((picture) => picture.setAttribute('data-stepped', '1'));
  await page.keyboard.press('o');
  await showMetadata(page);
  await expect(renditionDetails(page).getByText('Rendered RAW')).toBeVisible({ timeout: 120_000 });
  await expect(shownFrame(page)).toHaveAccessibleName(/Rendered RAW$/);
  // Both renditions inside the one picture, beside the neighbours' own.
  await expect(shown.locator('canvas[role="img"]')).toHaveCount(2);
  await expect(shown).toHaveAttribute('data-stepped', '1');
  expect(await shown.evaluate((picture) => picture.getAnimations().length)).toBe(0);

  // And the same photograph stepped to a second time still fades in: a reader going back and
  // forth arrives at each of a pair over and over, and an entrance declared once against
  // the element in a stylesheet does not reliably replay.
  const again = await stepOnto(page, 'ArrowRight', otherName);
  expect(again.some((frame) => frame.from === ARRIVING_SCALE)).toBe(true);
});

test('the next photo is fetched while the current one is on screen', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => {
    const match = new RegExp(
      `${route(PathSegment.image())}/([^/]+)${route(PathSegment.renditions(), 'full')}`,
    ).exec(r.url());
    if (match?.[1] != null) fetched.push(match[1]);
  });

  // Only a stored rendition is held. A library serving the camera's JPEG has nothing to
  // ask for here, so say which kind this is rather than inheriting it from whichever test
  // ran last.
  await setRenditionSource(page, FRAME_PHOTOS_DIR, 'render');
  // And which rendition it opens at, for the same reason: the setting is global
  // and its default follows whatever was last chosen, here and in every other
  // spec file.
  await setViewerRendition(page.request, 'full');
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible(FIRST_FRAME);

  // The neighbour is mounted only after this frame decodes, so it never competes for the
  // connection with the one being waited on.
  const openId = openPhotoId(page);
  await expect.poll(() => fetched.some((id) => id !== openId)).toBe(true);
});

// The two flashes this work started from, measured the way they were reported:
// every animation frame across a step, in the configuration they were seen in -
// a library that renders the RAW, read at the camera's JPEG.
//
// Both were about *which* file the viewer asked for and *when*, so both show up
// here as facts about the frames on screen: a step must never leave the stage
// empty, and the render must never be the picture, not even for a frame.
test('stepping through photos shows no empty stage and never the wrong rendition', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await setRenditionSource(page, FRAME_PHOTOS_DIR, 'render');
  await setViewerRendition(page.request, 'embedded');
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  // The neighbour is mounted once this frame is up, and the step below is only honest
  // with it in place - it is the whole of why there is no gap.
  await page.waitForTimeout(1500);

  // Only the frames after the route has moved on: the ones before it are the
  // photo being left, which is nobody's idea of a flash.
  const after = async (from: string): Promise<Sample[]> =>
    (await samplesOf(page, 'flash')).filter((s) => s.id !== from);

  const step = async (button: string): Promise<Sample[]> => {
    const from = openPhotoId(page);
    await page.evaluate(sampleShownFrame, 'flash');
    await page.getByRole('button', { name: button }).click();
    await page.waitForTimeout(2000);
    const frames = await after(from);
    expect(frames.length).toBeGreaterThan(30);
    return frames;
  };

  for (const button of ['Next photo', 'Previous photo']) {
    const frames = await step(button);
    // A blank frame is the stage's own background, which is what the reader
    // reported seeing between photos. The previous frame is held until the next
    // one has decoded, so there should be nothing to see: a couple of frames of
    // slack for a cold machine, not the hundreds of milliseconds a fetch takes.
    expect(
      frames.filter((f) => f.frame === '').length,
      `blank frames after ${button}`,
    ).toBeLessThanOrEqual(3);
    // And never the library's default. Painting the render first and swapping it
    // out is the second flash, and it is invisible to a request-level assertion
    // once the file is cached.
    expect(
      frames.filter((f) => f.frame.endsWith('Rendered RAW')),
      `render frames after ${button}`,
    ).toEqual([]);
  }
});

// The same measurement on a stage that has just loaded, and stepping back and forth over
// the same pair rather than walking forward: that is what a reader does with a fresh page,
// and each of those arrivals is at a photograph this stage has already held and painted.
test('stepping back and forth over a fresh stage shows no empty stage', async ({ page }) => {
  test.setTimeout(240_000);
  await setRenditionSource(page, FRAME_PHOTOS_DIR, 'render');
  await setViewerRendition(page.request, 'embedded');
  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  // Slow enough that a step which had to ask for its picture again would show: these
  // arrivals are all at photographs this stage has already painted, so none of them should.
  await page.route(new RegExp(`${route(PathSegment.image())}/`), async (intercepted) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await intercepted.continue();
  });
  await page.waitForTimeout(1500);

  const blanks = async (button: string): Promise<number> => {
    const from = openPhotoId(page);
    await page.evaluate(sampleShownFrame, 'flash');
    await page.getByRole('button', { name: button }).click();
    await page.waitForTimeout(1200);
    return (await samplesOf(page, 'flash')).filter((s) => s.id !== from && s.frame === '').length;
  };

  // Forward once, then the two the reader actually repeats: back to where they were, and
  // forward again. Both of those arrive at a photograph the stage painted moments ago.
  for (const button of ['Next photo', 'Previous photo', 'Next photo']) {
    expect(await blanks(button), `blank frames after ${button}`).toBeLessThanOrEqual(3);
  }
});

// Holding a neighbour is only worth anything if the reader lands on the URL it was held
// at. A rebuild announced while a neighbour is up moves that URL, and the frame the
// reader steps onto has to move with it - held per view, the two disagreed, and the plain
// URL the viewer fell back to is answered out of the copy the browser already has: the
// file from before the rebuild.
//
// A stored rendition, because only those carry the stamp. The camera's JPEG has none:
// nothing builds it, so nothing rewrites it under a URL a live page is holding, and a
// replaced RAW is caught by the ETag on the next mount instead (§13.5).
test('a neighbour rebuilt while it was held is painted at the URL it was held at', async ({
  page,
}) => {
  await setRenditionSource(page, FRAME_PHOTOS_DIR, 'render');
  await setViewerRendition(page.request, 'full');
  const [, secondPhoto] = await libraryPhotos(page, FRAME_PHOTOS_DIR);
  if (secondPhoto?.file_path == null) throw new Error('the library has no second photo');
  const secondId = secondPhoto.id;
  const secondName = path.basename(secondPhoto.file_path);
  const secondRender = `${route(PathSegment.image())}/${secondId}${route(PathSegment.renditions(), 'full')}`;
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(secondRender)) fetched.push(request.url());
  });

  // Built before it is held, or the neighbour's frame 404s and the stage drops it as
  // failed - there being nothing at that URL to rebuild. This library renders on request.
  await page.request.post(
    `${route(PathSegment.api(), PathSegment.photos(), secondId, PathSegment.renditions(), 'full')}`,
    { timeout: 180_000 },
  );

  await gotoPhoto(page, FRAME_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible(FIRST_FRAME);
  await expect(
    photoStage(page).getByRole('img', { name: `${secondName}, `, includeHidden: true }),
  ).toHaveCount(1);
  // What it is held at *before* the rebuild. The stamp is already on this URL, the build
  // above having written one, so waiting for `?v=` to appear would be a wait that was over
  // before it started - and the assertion at the end would then compare a stale URL with
  // itself and pass against the very regression this exists for.
  await expect.poll(() => fetched.length).toBeGreaterThan(0);
  const before = fetched.at(-1);

  // Rebuilt from under the reader while they are still on its neighbour. The request does
  // not answer until the render has, so it carries its own budget rather than the default.
  await page.request.post(
    `${route(PathSegment.api(), PathSegment.photos(), secondId, PathSegment.renditions(), 'full')}?force=true`,
    { timeout: 180_000 },
  );
  await expect.poll(() => fetched.at(-1), { timeout: 60_000 }).not.toBe(before);
  const heldAt = fetched.at(-1);

  const fetchedBeforeStep = fetched.length;
  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(shownFrame(page)).toHaveAccessibleName(`${secondName}, Rendered RAW`, {
    timeout: 60_000,
  });
  expect(
    fetched.slice(fetchedBeforeStep).filter((url) => url !== heldAt),
    'the step paints the frame already held',
  ).toEqual([]);
});

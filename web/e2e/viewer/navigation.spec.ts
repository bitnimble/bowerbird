// Getting around the detail view: what the header and the panels say about the
// photograph, stepping between them, and what happens when the catalogue answers
// late or not at all. What the picture itself does is `frames.spec.ts`, and how
// it is magnified is `zoom.spec.ts`.
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { PHOTO_NAMES, VIEWER_PHOTOS_DIR } from '../fixture_library';
import {
  frames,
  gallery,
  gotoLibrary,
  gotoPhoto,
  openPhoto,
  photoIdOfImageUrl,
  showMetadata,
  shownFrame,
  tiles,
  useLibrary,
} from '../helpers';

test.beforeAll(async ({ browser }) => {
  // This library serves the camera's JPEG, and the panels below say so, so the
  // viewer has to be opening at it rather than at whatever was last chosen.
  await useLibrary(browser, VIEWER_PHOTOS_DIR, { viewerRendition: 'embedded' });
});

test('the detail view shows shooting metadata, the triage control and steps between photos', async ({ page }) => {
  await gotoPhoto(page, VIEWER_PHOTOS_DIR);

  // Three-way triage in the header, not a checkbox: "undecided" has to be
  // expressible, and the control is there even with the metadata column closed
  // (the default).
  const triage = photoControls(page).getByLabel('Triage');
  await expect(triage.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Undecided' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Pick' })).toBeVisible();

  await showMetadata(page);

  // Located by title rather than by any text the panel holds: row values name the
  // camera too, which matches more than one panel.
  const panel = (title: string) => page.getByRole('group', { name: title, exact: true });

  // The fixture is portrait, so the panels sit in the full-height column beside
  // it and open on every row. ISO/shutter/aperture are read from the RAW header.
  const camera = panel('Camera');
  await expect(camera.getByText('Body', { exact: true })).toBeVisible();
  await expect(camera.getByText('Lens', { exact: true })).toBeVisible();
  await expect(camera.getByText('ISO', { exact: true })).toBeVisible();
  await expect(camera.getByText('Shutter', { exact: true })).toBeVisible();
  await expect(camera.getByText('Aperture', { exact: true })).toBeVisible();

  // Collapsing leaves the same two leading rows every panel keeps.
  await camera.getByRole('button', { name: /less/ }).click();
  await expect(camera.getByRole('term')).toHaveCount(2);

  await page.getByRole('button', { name: 'Hide metadata' }).click();
  await expect(camera).toHaveCount(0);
  await expect(triage.getByRole('button', { name: 'Pick' })).toBeVisible();
  await page.getByRole('button', { name: 'Show metadata' }).click();

  // The served rendition reports where its pixels came from and how it was encoded.
  // This library serves the camera's JPEG, which is passed through untouched, so
  // the encoder settings the built renditions carry do not describe it.
  const renditionPanel = panel('Rendition details');
  await expect(renditionPanel.getByText('Showing', { exact: true })).toBeVisible();
  await expect(renditionPanel.getByText('JPEG', { exact: true })).toBeVisible();
  await expect(renditionPanel.getByText('N/A')).toBeVisible();

  // Both panels name the file on the server they are describing. This library
  // serves the camera's JPEG, so the photo opens at the RAW's own bytes rather
  // than at a stored rendition - which is what makes them the same path here.
  const raw = panel('Original');
  const navPath = pathOf(page);
  const relative = await navPath.innerText();
  await expect(raw.getByText(path.join(VIEWER_PHOTOS_DIR, relative))).toBeVisible();

  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(navPath).not.toHaveText(relative);
});

// A real click on a real tile inside a scroller, which is what needs a browser;
// what the strip is *over* is `StripViewStore`'s arithmetic.
test('the filmstrip lists the collection, and a tile opens its own photograph', async ({ page }) => {
  await gotoPhoto(page, VIEWER_PHOTOS_DIR);

  const navPath = pathOf(page);
  const opened = await navPath.innerText();

  await page.getByRole('button', { name: 'Show filmstrip' }).click();
  const cells = tiles(page);
  await expect(cells).toHaveCount(PHOTO_NAMES.length);
  // The strip is the gallery's own tiles, so the photograph on the stage is the
  // one marked in it.
  await expect(gallery(page).locator('[role="listitem"][aria-current="page"]')).toHaveCount(1);

  await frames(cells.last()).click();
  await expect(navPath).not.toHaveText(opened);
  await expect(cells.last()).toHaveAttribute('aria-current', 'page');
});

test('a photo the catalogue does not have says so, with the reason', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), 'photo001'));

  // The other side of the state the viewer spent so long getting wrong: this is
  // the only thing that may render "not found", and it carries the read's own
  // error rather than whatever a list fetch last left behind.
  await expect(page.getByText('Photo unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText(/photo not found: photo001/)).toBeVisible();
});

// Two detail fetches can be in flight at once - stepping is faster than the
// round trip - and they need not answer in order.
test('a detail that lands after the reader has stepped on does not replace the photo they are looking at', async ({ page }) => {
  await gotoLibrary(page, VIEWER_PHOTOS_DIR);
  await expect(tiles(page)).toHaveCount(PHOTO_NAMES.length);

  const first = await tiles(page).first().locator('img').getAttribute('src');
  const firstId = photoIdOfImageUrl(first);
  expect(firstId).not.toBe('');
  await page.route(`**${route(PathSegment.api(), PathSegment.photos(), firstId)}`, async (intercepted) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await intercepted.continue();
  });

  // Stepping off before the first photo's detail has landed. The buttons have to
  // be live for that: their neighbours come from the photo the route asks for,
  // not from the detail that has not arrived, or the first frame of every photo
  // opened from the grid is a dead end.
  await openPhoto(page);
  await page.getByRole('button', { name: 'Next photo' }).click();
  const navPath = pathOf(page);
  await expect(navPath).not.toHaveText('', { timeout: 30_000 });
  const stepped = await navPath.innerText();

  // The straggler names a photo the reader has already left. Written anyway, it
  // puts the previous photo's detail back in a store the page reads by id, so the
  // page reports the photo in the URL as one the catalogue does not have.
  await page.waitForTimeout(4000);
  await expect(page.getByText('Photo unavailable')).toHaveCount(0);
  await expect(navPath).toHaveText(stepped);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// Regression: the run of photographs the arrows walk is emptied whenever the
// collection is re-read, but the anchor it is asked for is the open photo's id -
// so re-opening the *same* photo left the anchor unchanged, the reaction never
// fired, and both arrows stayed dead for as long as that photo was open. Every
// photo of a small collection is within the margin, so it was not an edge case.
test('the arrows come back after leaving a photo and opening it again', async ({ page }) => {
  await gotoPhoto(page, VIEWER_PHOTOS_DIR);
  await expect(page.getByRole('button', { name: 'Next photo' })).toBeEnabled({ timeout: 60_000 });

  for (let round = 0; round < 2; round++) {
    await page.keyboard.press('Escape');
    await expect(gallery(page)).toBeVisible();
    await openPhoto(page);
    await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Next photo' }), `after ${round + 1} trips`).toBeEnabled({ timeout: 30_000 });
  }
});

// Regression: the panels were gated on this photo's detail arriving, so the strip
// under a landscape frame collapsed to nothing while it was in flight and the
// stage - a grid track sized against that strip - painted the photo full-size and
// then shrank it when the panels landed.
test('the panels keep their shape while the next photo is loading', async ({ page }) => {
  await gotoPhoto(page, VIEWER_PHOTOS_DIR);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  await showMetadata(page);

  // Held open, or the API answers before there is a loading state to observe.
  await page.route(new RegExp(`${route(PathSegment.api(), PathSegment.photos())}/[^/?]+$`), async (intercepted) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await intercepted.continue();
  });

  // Every panel is up while the fetch is still out, holding its rows empty rather
  // than by keeping the previous photo's values.
  await page.getByRole('button', { name: 'Next photo' }).click();
  const details = page.getByRole('region', { name: 'Photo details' });
  const camera = details.getByRole('group', { name: 'Camera', exact: true });
  await expect(camera.getByText('loading').first()).toBeVisible();
  // Notes, Edits, Camera, Rendition, Original - triage is in the header and the rating in its menu.
  await expect(details.getByRole('group', { name: /^(Notes|Edits|Camera|Rendition details|Original)$/ })).toHaveCount(5);
});

function photoControls(page: Page): Locator {
  return page.getByRole('group', { name: 'Photo controls' });
}

// The bar names the file on screen by its path, which is empty until the photo's row is in.
function pathOf(page: Page): Locator {
  return photoControls(page).getByText(/\.arw$/i);
}

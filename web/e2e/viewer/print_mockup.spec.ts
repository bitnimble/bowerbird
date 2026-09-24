// The print mockup as the viewer offers it: a soft proof that replaces the stage with the
// editor's print renderer and leaves the photograph untouched. What the renderer draws is
// `editor/raw_editing.spec.ts`; this is only the way in and the way back out.
import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { PRINT_PHOTOS_DIR } from '../fixture_library';
import {
  editDiagnosticSize,
  editDiagnostics,
  editTools,
  openLibrary,
  openPhoto,
  openPhotoId,
  savedRev,
  softProof,
  useLibrary,
} from '../helpers';

// The mockup's stage is the print's own region rather than the viewer's "Photo", so the
// editor's live helper cannot see it: a drawn mode is what says a device rendered this.
const DRAWN = { timeout: 170_000 };

// The full rendition built on the server first, where nothing has asked for it yet.
test.describe.configure({ timeout: 180_000, mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, PRINT_PHOTOS_DIR, { viewerRendition: 'Embedded JPEG' });
});

test('the viewer shows a print mockup and comes back to the photograph unedited', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);
  const photoId = openPhotoId(page);
  const photoPath = new URL(page.url()).pathname;
  const revision = await savedRev(page, photoId);

  // The camera's JPEG is what this library shows, so its own gamut is the proof in force.
  await expect(page.getByRole('button', { name: 'Soft proof: sRGB' })).toBeVisible();
  await softProof(page, 'Printed media (3D)');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Lighting', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${photoPath}${route(PathSegment.mockup())}`);
  // The mockup is a way of looking at the photograph, not a grade: no toolbar, and
  // nothing of the editor's saved onto it.
  await expect(editTools(page)).toHaveCount(0);

  await softProof(page, 'sRGB');
  await expect(page.getByRole('img', { name: 'Edit preview' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(photoPath);
  expect(await savedRev(page, photoId)).toBe(revision);
});

test('the flat print and the sheet are one open, and the flat one has no light to set', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);

  await softProof(page, 'Printed media');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Paper', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Lighting', exact: true })).toHaveCount(0);
  const opened = await editDiagnosticSize(page, 'data-size');

  await softProof(page, 'Printed media (3D)');
  await expect(page.getByRole('group', { name: 'Lighting', exact: true })).toBeVisible();
  expect(await editDiagnosticSize(page, 'data-size')).toEqual(opened);
});

test('the mockup opens on its own address', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);
  const photoPath = new URL(page.url()).pathname;
  await page.goto(`${photoPath}${route(PathSegment.mockup())}`);
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Paper', exact: true })).toBeVisible();
});

// A sheet two thousand pixels across does not need the sensor, and the full rendition already
// holds every edit: the RAW never crosses.
test('the mockup is drawn from the full rendition rather than the RAW', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);
  const requested: URL[] = [];
  page.on('request', (request) => requested.push(new URL(request.url())));

  await softProof(page, 'Printed media (3D)');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  const prepares = requested.filter((url) => url.pathname.endsWith(route(PathSegment.prepare())));
  expect(prepares.length).toBeGreaterThan(0);
  expect(prepares.every((url) => url.searchParams.get('from') === 'rendition')).toBe(true);
  expect(requested.filter((url) => url.pathname.endsWith(route(PathSegment.download(), 'original')))).toEqual([]);
  // Still more than the sheet can show at any angle.
  expect(Math.max(...(await editDiagnosticSize(page, 'data-size')))).toBeGreaterThan(2500);
});

test('escape leaves the print mockup', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);
  const photoPath = new URL(page.url()).pathname;
  await softProof(page, 'Printed media (3D)');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'Edit preview' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(photoPath);
});

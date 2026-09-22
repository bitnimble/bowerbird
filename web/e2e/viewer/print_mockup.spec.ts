// The print mockup as the viewer offers it: a menu row that replaces the stage with the
// editor's print renderer and leaves the photograph untouched. What the renderer draws is
// `editor/raw_editing.spec.ts`; this is only the way in and the way back out.
import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { PRINT_PHOTOS_DIR } from '../fixture_library';
import {
  editDiagnosticSize,
  editDiagnostics,
  openLibrary,
  openPhoto,
  openPhotoId,
  photoAction,
  savedRev,
  useLibrary,
  waitForEditorLive,
} from '../helpers';

// The mockup's stage is the print's own region rather than the viewer's "Photo", so the
// editor's live helper cannot see it: a drawn mode is what says a device rendered this.
const DRAWN = { timeout: 170_000 };

// A real RAW decode on the browser's own adapter, same as the editor's.
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

  await photoAction(page, 'View', 'View print mockup', { exact: true });
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Paper', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${photoPath}${route(PathSegment.mockup())}`);
  // The mockup is a way of looking at the photograph, not a grade: no toolbar, and
  // nothing of the editor's saved onto it.
  await expect(page.getByRole('radio', { name: 'Print', exact: true })).toHaveCount(0);

  await photoAction(page, 'View', 'View photo', { exact: true });
  await expect(page.getByRole('img', { name: 'Edit preview' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(photoPath);
  expect(await savedRev(page, photoId)).toBe(revision);
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

// A sheet two thousand pixels across does not need the sensor, and the editor's open is sized for
// a loupe the mockup does not have: whole, a 61MP frame is a gigabyte of samples and pyramid.
test('the mockup opens the photograph smaller than the editor does', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);
  const photoPath = new URL(page.url()).pathname;

  await photoAction(page, 'View', 'View print mockup', { exact: true });
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  const mockup = Math.max(...(await editDiagnosticSize(page, 'data-size')));

  await page.goto(`${photoPath}?edit`);
  await waitForEditorLive(page);
  const editor = Math.max(...(await editDiagnosticSize(page, 'data-size')));
  expect(mockup).toBeLessThan(editor * 0.6);
  // Still more than the sheet can show at any angle.
  expect(mockup).toBeGreaterThan(2500);
});

test('escape leaves the print mockup', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, PRINT_PHOTOS_DIR);
  await openPhoto(page);
  const photoPath = new URL(page.url()).pathname;
  await photoAction(page, 'View', 'View print mockup', { exact: true });
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'Edit preview' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(photoPath);
});

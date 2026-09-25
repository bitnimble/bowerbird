// The print mockup as the viewer offers it: a soft proof that replaces the stage with the
// editor's print renderer and leaves the photograph untouched. What the renderer draws, and how
// it turns under a pointer, is `editor/raw_editing.spec.ts`; this is the way in, what it is drawn
// from, and the way back out.
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PRINT_PHOTOS_DIR } from '../fixture_library';
import {
  editDiagnosticSize,
  editDiagnostics,
  editTools,
  gotoPhoto,
  savedRev,
  softProof,
  useLibrary,
} from '../helpers';

// The mockup's stage is the print's own region rather than the viewer's "Photo", so the
// editor's live helper cannot see it: a drawn mode is what says a device rendered this.
const DRAWN = { timeout: 170_000 };

// The max rendition built on the server first, where nothing has asked for it yet.
test.describe.configure({ timeout: 180_000, mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, PRINT_PHOTOS_DIR);
});

// The max rendition holds every edit at the sensor's own size: the RAW never crosses, and this
// browser decodes the rendition itself.
test('the viewer shows a print mockup from the max rendition, and comes back to the photograph unedited', async ({ page }) => {
  const photoId = await gotoPhoto(page, PRINT_PHOTOS_DIR);
  const photoPath = new URL(page.url()).pathname;
  const revision = await savedRev(page, photoId);
  const requested: URL[] = [];
  page.on('request', (request) => requested.push(new URL(request.url())));

  // The camera's JPEG is what this library shows, so its own gamut is the proof in force.
  await expect(page.getByRole('button', { name: 'Soft proof: SDR' })).toBeVisible();
  await softProof(page, 'Printed media (3D)');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Lighting', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${photoPath}${route(PathSegment.mockup())}`);
  // The mockup is a way of looking at the photograph, not a grade: no toolbar, and
  // nothing of the editor's saved onto it.
  await expect(editTools(page)).toHaveCount(0);

  const max = route(PathSegment.renditions(), 'max');
  expect(requested.some((url) => url.pathname.endsWith(max))).toBe(true);
  expect(requested.filter((url) => url.pathname.endsWith(route(PathSegment.prepare())))).toEqual([]);
  expect(requested.filter((url) => url.pathname.endsWith(route(PathSegment.download(), 'original')))).toEqual([]);
  // Still more than the sheet can show at any angle.
  expect(Math.max(...(await editDiagnosticSize(page, 'data-size')))).toBeGreaterThan(2500);

  await softProof(page, 'SDR (sRGB)');
  await expect(page.getByRole('img', { name: 'Edit preview' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(photoPath);
  expect(await savedRev(page, photoId)).toBe(revision);
});

test('the flat print and the sheet are one open, and the flat one has no light to set', async ({ page }) => {
  await gotoPhoto(page, PRINT_PHOTOS_DIR);

  await softProof(page, 'Printed media');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Paper', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Lighting', exact: true })).toHaveCount(0);
  const opened = await editDiagnosticSize(page, 'data-size');

  await softProof(page, 'Printed media (3D)');
  await expect(page.getByRole('group', { name: 'Lighting', exact: true })).toBeVisible();
  expect(await editDiagnosticSize(page, 'data-size')).toEqual(opened);
});

test('the mockup opens on its own address, and escape leaves it', async ({ page }) => {
  await gotoPhoto(page, PRINT_PHOTOS_DIR, route(PathSegment.mockup()));
  const photoPath = new URL(page.url()).pathname.replace(new RegExp(`${route(PathSegment.mockup())}$`), '');
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print', DRAWN);
  await expect(page.getByRole('group', { name: 'Paper', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'Edit preview' })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(photoPath);
});

// A stage that outgrows the rendition is served tiles of it from the server, and the frame drawn
// from them takes its camera match and balance from the open's own answer.
test('a rendition opened in the browser draws from the tiles it is served', async ({ page }) => {
  const photoId = await gotoPhoto(page, PRINT_PHOTOS_DIR);
  const shown = await page.evaluate(async (photoId) => {
    const { LocalDecoder } = await import('/src/features/raw_edit/local_decode/local_decoder.ts');
    const { preparedPicture } = await import('/src/features/raw_edit/local_decode/open_photo.ts');
    const { renditionsApi } = await import('/src/api/renditions.ts');
    await renditionsApi.build(photoId, 'max');
    const avif = new Uint8Array(await (await fetch(renditionsApi.url(photoId, 'max'))).arrayBuffer());
    const decoder = new LocalDecoder();
    try {
      const opened = await decoder.holdRendition(avif, {
        longEdge: 0,
        grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
        defringe: 0,
        statedWhite: true,
      });
      if (opened == null) return 'this browser cannot hand over planar PQ';
      const { width, height } = JSON.parse(opened) as { width: number; height: number };
      const level: [number, number] = [width, height];
      const whole: [number, number, number, number] = [0, 0, width, height];
      const { missing } = await decoder.showTiles(level, whole);
      if (missing == null) return 'nothing was missing';
      await decoder.takeTiles(await preparedPicture(photoId, { level: 0, at: whole, parts: missing }, 'rendition'), missing);
      return JSON.stringify(await decoder.showTiles(level, whole));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      decoder.close();
    }
  }, photoId);
  expect(shown).toBe('{"missing":null}');
});

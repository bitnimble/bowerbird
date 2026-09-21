import { expect, test } from '@playwright/test';
import { z } from 'zod';
import { PathSegment, route } from '../../../src/schemas/route';
import { MOBILE_EDIT_PHOTOS_DIR } from '../fixture_library';
import { editDiagnostics, editPreview, editTools, openLibrary, openPhoto, openPhotoId, photoStage, useLibrary, waitForEditorLive } from '../helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.describe.configure({ timeout: 180_000 });

let photoId = '';
test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, MOBILE_EDIT_PHOTOS_DIR);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false });
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, MOBILE_EDIT_PHOTOS_DIR);
  await openPhoto(page);
  photoId = openPhotoId(page);
  await page.close();
});

test('phone tilt changes print lighting while the photo keeps its editor framing', async ({ page }) => {
  await page.addInitScript(() => {
    let requests = 0;
    Object.defineProperty(globalThis, 'motionPermissionRequests', { get: () => requests });
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', {
      value: async () => { requests += 1; return 'granted'; }, configurable: true,
    });
  });
  await page.route(/\/local_open_worker\.ts(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `
        let printMotionScene = null;
        Object.defineProperty(globalThis, 'printMotionScene', { get: () => printMotionScene });
        self.addEventListener('message', (event) => {
          if (event.data?.kind === 'tick') printMotionScene = event.data.print;
        });
        ${await response.text()}
      `,
    });
  });
  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await waitForEditorLive(page);
  const aspect = await editPreview(page).evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.height);
  const worker = page.workers().find((worker) => worker.url().includes('local_open_worker'));
  if (worker == null) throw new Error('The editor worker was not created');
  const Scene = z.object({ presentation: z.literal('surface'), yawDegrees: z.number(), pitchDegrees: z.number() });
  const scene = async (): Promise<z.infer<typeof Scene>> => Scene.parse(
    await worker.evaluate(() => Reflect.get(globalThis, 'printMotionScene')),
  );
  await editTools(page).getByRole('radio', { name: 'Print', exact: true }).click();
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'print');
  await expect(page.getByRole('region', { name: 'Rotate print' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Horizontal rotation' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Vertical rotation' })).toHaveCount(0);
  await expect.poll(async () => editPreview(page).evaluate((canvas: HTMLCanvasElement) => canvas.width / canvas.height))
    .toBeCloseTo(aspect, 2);
  expect(await scene()).toEqual({ presentation: 'surface', yawDegrees: 0, pitchDegrees: 0 });
  expect(await page.evaluate(() => Reflect.get(globalThis, 'motionPermissionRequests'))).toBe(0);
  await page.getByRole('tab', { name: 'Device tilt', exact: true }).click();
  await page.getByRole('button', { name: 'Enable tilt', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, 'motionPermissionRequests'))).toBe(1);
  await page.evaluate(async () => {
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 90, gamma: 0 }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 65, gamma: 15 }));
  });
  await expect.poll(async () => (await scene()).yawDegrees).toBeCloseTo(15, 3);
  await expect.poll(async () => (await scene()).pitchDegrees).toBeCloseTo(-25, 3);
  await expect(page.getByText('Tilt your phone to move the reflections.')).toBeVisible();
  const tilted = await scene();
  const box = await editPreview(page).boundingBox();
  if (box == null) throw new Error('The print has no layout box');
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + 50 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  expect(await scene()).toEqual(tilted);
  await editTools(page).getByRole('radio', { name: 'Cursor', exact: true }).click();
  await expect(editDiagnostics(page)).toHaveAttribute('data-rendered-mode', 'photo');
  await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 20, gamma: -30 })));
  expect(await worker.evaluate(() => Reflect.get(globalThis, 'printMotionScene'))).toBeNull();
});

test('footer panels overlay the photo and isolate a slider throughout a touch drag', async ({ page }) => {
  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await waitForEditorLive(page);
  const tabs = page.getByRole('tablist', { name: 'Edit panels' });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  const initial = await photoStage(page).boundingBox();
  await tabs.getByRole('tab', { name: 'Light', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Light', exact: true });
  await expect(panel).toHaveCSS('opacity', '1');
  await expect(panel).toHaveCSS('position', 'fixed');
  expect(await photoStage(page).boundingBox()).toEqual(initial);
  const slider = panel.getByRole('slider', { name: 'Exposure', exact: true });
  await page.keyboard.press('Tab');
  await expect(slider).toBeFocused();
  const value = await slider.getAttribute('aria-valuenow');
  const box = await slider.boundingBox();
  if (box == null) throw new Error('The exposure slider has no layout box');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  const isolated = page.getByRole('region', { name: 'Adjusting Exposure', exact: true });
  await expect(isolated).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '0');
  await expect(isolated).toContainText('EV');
  await expect(isolated).toHaveCSS('position', 'fixed');
  expect(await photoStage(page).boundingBox()).toEqual(initial);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 55, y: point.y }] });
  await expect.poll(() => slider.getAttribute('aria-valuenow')).not.toBe(value);
  await expect(isolated).toBeVisible();
  await expect(panel).toHaveCSS('opacity', '0');
  await page.screenshot({ path: '/tmp/bowerbird-mobile-slider-drag.png' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(isolated).toHaveCount(0);
  await expect(panel).toHaveCSS('opacity', '1');
  expect(await photoStage(page).boundingBox()).toEqual(initial);
  await page.screenshot({ path: '/tmp/bowerbird-mobile-panel-open.png' });
  await tabs.getByRole('tab', { name: 'Light', exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Light', exact: true, includeHidden: true })).toHaveCSS('visibility', 'hidden');
  expect(await photoStage(page).boundingBox()).toEqual(initial);
  await page.screenshot({ path: '/tmp/bowerbird-mobile-footer.png' });
  await cdp.detach();
});

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
  expect(await page.evaluate(() => Reflect.get(globalThis, 'motionPermissionRequests'))).toBe(1);
  await page.getByRole('tab', { name: 'Device tilt', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable tilt', exact: true })).toHaveCount(0);
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
  await photoStage(page).evaluate((stage) => {
    const events: string[] = [];
    Object.defineProperty(stage, 'panelGestureEvents', { value: events });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel']) {
      stage.addEventListener(type, () => events.push(type));
    }
  });
  await tabs.getByRole('tab', { name: 'Light', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: 'Light', exact: true });
  await expect(panel).toHaveCSS('opacity', '1');
  await expect(panel).toHaveCSS('position', 'fixed');
  expect(await photoStage(page).boundingBox()).toEqual(initial);
  const canvas = await editPreview(page).boundingBox();
  if (canvas == null) throw new Error('The photo has no layout box');
  const outside = { x: canvas.x + canvas.width / 2, y: canvas.y + 20 };
  await page.touchscreen.tap(outside.x, outside.y);
  await expect(panel).not.toBeVisible();
  expect(await photoStage(page).evaluate((stage) => Reflect.get(stage, 'panelGestureEvents'))).toEqual([]);
  await tabs.getByRole('tab', { name: 'Colour', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Colour', exact: true })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Light', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Close edit panel' })).toBeVisible();
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
  expect(await photoStage(page).evaluate((stage) => Reflect.get(stage, 'panelGestureEvents'))).toEqual([]);
  await page.screenshot({ path: '/tmp/bowerbird-mobile-panel-open.png' });
  await tabs.getByRole('tab', { name: 'Light', exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Light', exact: true, includeHidden: true })).toHaveCSS('visibility', 'hidden');
  expect(await photoStage(page).boundingBox()).toEqual(initial);
  await page.screenshot({ path: '/tmp/bowerbird-mobile-footer.png' });
  await cdp.detach();
});

for (const { device, viewport, hasTouch, isMobile } of [
  { device: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { device: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false },
]) {
  test.describe(`${device} print controls`, () => {
    test.use({ viewport, hasTouch, isMobile });
    test('every slider spans the panel width', async ({ page }) => {
      await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
      await waitForEditorLive(page);
      await editTools(page).getByRole('radio', { name: 'Print', exact: true }).click();
      for (const { name, count } of [
        { name: 'Paper', count: 6 },
        { name: 'Lighting', count: 7 },
        ...(!isMobile ? [{ name: 'Rotation', count: 2 }] : []),
      ]) {
        if (isMobile) await page.getByRole('tab', { name, exact: true }).click();
        const group = page.getByRole('group', { name, exact: true });
        await expect(group).toBeVisible();
        const widths = await group.getByRole('slider').evaluateAll((sliders) => sliders.map((slider) => {
          const panel = slider.closest('[role="group"]');
          const track = slider.parentElement?.parentElement;
          if (panel == null || track == null) throw new Error('The print slider has no track or panel');
          const style = getComputedStyle(panel);
          const contentWidth = panel.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
            - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
          return track.getBoundingClientRect().width / contentWidth;
        }));
        expect(widths).toHaveLength(count);
        for (const width of widths) expect(width).toBeCloseTo(1, 2);
      }
    });
  });
}

test.describe('zoom on a high density phone display', () => {
  test.use({ deviceScaleFactor: 3 });

  for (const { tool, panel, slider } of [
    { tool: 'Cursor', panel: 'Light', slider: 'Exposure' },
    { tool: 'Print', panel: 'Lighting', slider: 'Ambient light' },
  ]) {
    test(`tapping the photo in ${tool} loads detail and keeps sliders usable`, async ({ page }) => {
      await page.route(/\/local_open_worker\.ts(?:\?|$)/, async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          body: `
            const zoomRequests = new Map();
            const zoomWindows = new Map();
            const zoomDrawn = new Set();
            let zoomReady = [];
            Object.defineProperty(globalThis, 'drawnPhotoWindows', { get: () => [...zoomDrawn] });
            self.addEventListener('message', ({ data }) => {
              zoomRequests.set(data.id, { kind: data.kind, level: data.level, ready: zoomReady });
              if (data.kind === 'takeTiles') zoomReady = [];
            });
            const zoomSend = self.postMessage.bind(self);
            self.postMessage = (answer, ...rest) => {
              const request = zoomRequests.get(answer.id);
              zoomRequests.delete(answer.id);
              if (answer.ok && request?.kind === 'takeTiles') {
                const header = JSON.parse(answer.value);
                if (header.window != null) {
                  const key = JSON.stringify([header.level, header.window.canvas, header.window.origin]);
                  zoomWindows.set(key, JSON.stringify(header.window.canvas));
                }
              }
              if (answer.ok && request?.kind === 'showTiles' && answer.value.missing === null) {
                zoomReady = [...zoomWindows].filter(([, level]) => level === request.level).map(([key]) => key);
              }
              if (answer.ok && request?.kind === 'tick') {
                for (const key of request.ready) zoomDrawn.add(key);
              }
              zoomSend(answer, ...rest);
            };
            ${await response.text()}
          `,
        });
      });
      await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
      await waitForEditorLive(page);
      const worker = page.workers().find((worker) => worker.url().includes('local_open_worker'));
      if (worker == null) throw new Error('The editor worker was not created');
      await editTools(page).getByRole('radio', { name: tool, exact: true }).click();
      if (tool === 'Print') {
        const paper = page.getByRole('tab', { name: 'Paper', exact: true });
        await paper.click();
        await page.getByRole('checkbox', { name: 'Add frame', exact: true }).check();
        await paper.click();
      }
      const drawnWindows = async (): Promise<string[]> => z.array(z.string()).parse(
        await worker.evaluate(() => Reflect.get(globalThis, 'drawnPhotoWindows')),
      );
      const previous = new Set(await drawnWindows());
      const prepared = page.waitForResponse((reply) => {
        const url = new URL(reply.url());
        const region = url.searchParams.get('region');
        return url.pathname.endsWith('/prepare') && region != null && Number(region.split(',')[2]) < 0.99;
      });
      await editPreview(page).tap();
      const response = await prepared;
      expect(response.status()).toBe(200);
      await expect.poll(async () => (await drawnWindows()).some((key) => !previous.has(key))).toBe(true);
      await expect(page.getByText(/^Unavailable/)).toHaveCount(0);
      await page.getByRole('tab', { name: panel, exact: true }).click();
      const control = page.getByRole('slider', { name: slider, exact: true });
      await expect(control).toBeEnabled();
      const before = await control.getAttribute('aria-valuenow');
      await control.press('ArrowRight');
      await expect.poll(() => control.getAttribute('aria-valuenow')).not.toBe(before);
      await expect(page.getByText(/^Unavailable/)).toHaveCount(0);
    });
  }
});

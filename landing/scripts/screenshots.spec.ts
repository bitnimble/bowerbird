import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import { PathSegment, route } from '../../src/schemas/route';
import { API_URL, LIBRARY_ROOT, PHOTO_COUNT, SHOTS_DIR } from './shots_state';

test.describe.configure({ mode: 'serial' });

type Photo = {
  id: string;
  file_path: string | null;
  tile_built_at: string | null;
  renditions_built_at: string | null;
};

const PRINT_SETTLE_MS = 3_000;

let api: APIRequestContext;
let libraryId = '';
const photoIds = new Map<string, string>();

function idOf(fileName: string): string {
  const id = photoIds.get(fileName);
  if (id == null) throw new Error(`no photo named ${fileName}`);
  return id;
}

async function listPhotos(): Promise<Photo[]> {
  const response = await api.get(
    `${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.photos())}?limit=200`,
  );
  return ((await response.json()) as { photos: Photo[] }).photos;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, page.viewportSize()?.height ?? 0);
  await page.screenshot({
    path: path.join(SHOTS_DIR, name),
    type: 'jpeg',
    quality: 85,
    animations: 'disabled',
  });
}

function stage(page: Page): Locator {
  return page.getByRole('region', { name: 'Photo', exact: true });
}

function gallery(page: Page): Locator {
  return page.getByRole('list', { name: /^\d+ photos$/ });
}

async function stageReady(page: Page): Promise<void> {
  await expect(stage(page).getByRole('img')).toBeVisible({ timeout: 120_000 });
  await expect(stage(page)).toHaveAttribute('aria-busy', 'false', { timeout: 120_000 });
}

async function openEditor(page: Page, photoId: string): Promise<void> {
  await page.goto(route(PathSegment.photos(), photoId, PathSegment.edit()));
  await expect(stage(page).getByRole('img', { name: 'Edit preview' })).toBeVisible({
    timeout: 300_000,
  });
  // Not busy is live or failed, and a failed open is no picture to take.
  await expect(stage(page)).toHaveAttribute('aria-busy', 'false', { timeout: 300_000 });
  await expect(
    page.getByRole('region', { name: 'Photo details' }).getByText(/^Unavailable/),
  ).toHaveCount(0);
}

async function pressRepeatedly(target: Locator, key: string, times: number): Promise<void> {
  for (let at = 0; at < times; at++) await target.press(key);
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: API_URL });
  const created = await api.post(route(PathSegment.api(), PathSegment.libraries()), {
    data: { root_path: LIBRARY_ROOT, include_non_raw: true, auto_stack: false },
  });
  expect(created.ok(), await created.text()).toBe(true);
  libraryId = ((await created.json()) as { id: string }).id;

  await expect
    .poll(
      async () => {
        const photos = await listPhotos();
        return (
          photos.length === PHOTO_COUNT &&
          photos.every((photo) => photo.tile_built_at != null && photo.renditions_built_at != null)
        );
      },
      { timeout: 1_200_000, intervals: [5_000] },
    )
    .toBe(true);
  for (const photo of await listPhotos())
    photoIds.set(path.basename(photo.file_path ?? ''), photo.id);

  const verdicts: [string, { rating?: number; triage?: 'picked' }][] = [
    ['AFXT2721.RAF', { rating: 5, triage: 'picked' }],
    ['sunset.avif', { rating: 4, triage: 'picked' }],
    ['DSCF8146.RAF', { rating: 3 }],
  ];
  for (const [name, data] of verdicts) {
    await api.patch(route(PathSegment.api(), PathSegment.photos(), idOf(name)), { data });
  }
});

test.afterAll(async () => {
  await api.dispose();
});

test('viewer', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), idOf('sunset.avif')));
  await stageReady(page);
  await page.getByRole('button', { name: 'Show filmstrip' }).click();
  await expect(gallery(page)).toBeVisible();
  await shot(page, 'viewer.jpg');
});

test('editor', async ({ page }) => {
  await openEditor(page, idOf('AFXT2721.RAF'));
  await shot(page, 'editor.jpg');
});

test('print', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), idOf('autumn.ARW'), PathSegment.mockup()));
  await expect(page.getByTestId('raw-edit-diagnostics')).toHaveAttribute(
    'data-rendered-mode',
    'print',
    { timeout: 300_000 },
  );
  await page.getByRole('combobox', { name: 'Paper', exact: true }).click();
  await page.getByRole('option', { name: 'Satin', exact: true }).click();
  await page.getByRole('combobox', { name: 'Environment', exact: true }).click();
  await page.getByRole('option', { name: 'Dim hotel room', exact: true }).click();
  await pressRepeatedly(page.getByRole('slider', { name: 'Light intensity' }), 'ArrowUp', 60);
  await expect(page.getByRole('slider', { name: 'Light intensity' })).toHaveAttribute(
    'aria-valuetext',
    '120 lx',
  );
  await pressRepeatedly(page.getByRole('slider', { name: 'Light temperature' }), 'ArrowUp', 29);
  await expect(page.getByRole('slider', { name: 'Light temperature' })).toHaveAttribute(
    'aria-valuetext',
    '6,500 K',
  );
  const print = page.getByRole('region', { name: 'Rotate print' });
  await print.press('Home');
  await pressRepeatedly(print, 'Shift+ArrowUp', 4);
  await pressRepeatedly(print, 'ArrowRight', 2);
  await pressRepeatedly(print, 'ArrowDown', 3);
  await expect(page.getByRole('slider', { name: 'Horizontal rotation' })).toHaveAttribute(
    'aria-valuenow',
    '-2',
  );
  await expect(page.getByRole('slider', { name: 'Vertical rotation' })).toHaveAttribute(
    'aria-valuenow',
    '-37',
  );
  // Focusing the light sliders scrolled the panel down to them.
  await page.getByRole('combobox', { name: 'Paper', exact: true }).scrollIntoViewIfNeeded();
  // The sheet draws in the GPU worker, which says nothing once a redraw lands.
  await page.waitForTimeout(PRINT_SETTLE_MS);
  await shot(page, 'print.jpg');
});

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });

  test('viewer', async ({ page }) => {
    await page.goto(route(PathSegment.photos(), idOf('DSC00853.ARW')));
    await stageReady(page);
    await shot(page, 'mobile-viewer.jpg');
  });
});

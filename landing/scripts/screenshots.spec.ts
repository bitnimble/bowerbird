import { expect, request, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { PathSegment, route } from '../../src/schemas/route';
import { API_URL, LIBRARY_ROOT, PHOTO_COUNT, SHOTS_DIR } from './shots_state';

test.describe.configure({ mode: 'serial' });

type Photo = { id: string; file_path: string | null; tile_built_at: string | null; renditions_built_at: string | null };

let api: APIRequestContext;
let libraryId = '';
const photoIds = new Map<string, string>();

function idOf(fileName: string): string {
  const id = photoIds.get(fileName);
  if (id == null) throw new Error(`no photo named ${fileName}`);
  return id;
}

async function listPhotos(): Promise<Photo[]> {
  const response = await api.get(`${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.photos())}?limit=200`);
  return ((await response.json()) as { photos: Photo[] }).photos;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, page.viewportSize()?.height ?? 0);
  await page.screenshot({ path: path.join(SHOTS_DIR, name), type: 'jpeg', quality: 85, animations: 'disabled' });
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

async function openLibraryGrid(page: Page): Promise<void> {
  await page.goto('/');
  await expect(gallery(page).getByRole('listitem')).toHaveCount(PHOTO_COUNT, { timeout: 60_000 });
  await expect(gallery(page).locator('[role="listitem"][aria-busy="true"]')).toHaveCount(0, { timeout: 60_000 });
}

async function openEditor(page: Page, photoId: string): Promise<void> {
  await page.goto(`${route(PathSegment.photos(), photoId)}?edit=1`);
  await expect(stage(page).getByRole('img', { name: 'Edit preview' })).toBeVisible({ timeout: 300_000 });
  // Not busy is live or failed, and a failed open is no picture to take.
  await expect(stage(page)).toHaveAttribute('aria-busy', 'false', { timeout: 300_000 });
  await expect(page.getByRole('region', { name: 'Photo details' }).getByText(/^Unavailable/)).toHaveCount(0);
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
        return photos.length === PHOTO_COUNT && photos.every((photo) => photo.tile_built_at != null && photo.renditions_built_at != null);
      },
      { timeout: 1_200_000, intervals: [5_000] },
    )
    .toBe(true);
  for (const photo of await listPhotos()) photoIds.set(path.basename(photo.file_path ?? ''), photo.id);

  const verdicts: [string, { rating?: number; triage?: 'picked' }][] = [
    ['AFXT2721.RAF', { rating: 5, triage: 'picked' }],
    ['sunset.avif', { rating: 4, triage: 'picked' }],
    ['DSCF8146.RAF', { rating: 3 }],
  ];
  for (const [name, data] of verdicts) {
    await api.patch(route(PathSegment.api(), PathSegment.photos(), idOf(name)), { data });
  }
  const album = await api.post(route(PathSegment.api(), PathSegment.albums()), { data: { name: 'Favourites' } });
  const albumId = ((await album.json()) as { id: string }).id;
  await api.post(route(PathSegment.api(), PathSegment.albums(), albumId, PathSegment.photos()), {
    data: { photo_ids: [idOf('AFXT2721.RAF'), idOf('sunset.avif'), idOf('arches.avif')] },
  });
});

test.afterAll(async () => {
  await api.dispose();
});

test('grid and sidebar', async ({ page }) => {
  await openLibraryGrid(page);
  await shot(page, 'grid.jpg');

  await page.getByRole('button', { name: 'Expand Shoots' }).click();
  await page.getByRole('button', { name: 'Expand Albums' }).click();
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Favourites' })).toBeVisible();
  await shot(page, 'sidebar.jpg');
});

test('viewer', async ({ page }) => {
  await page.goto(route(PathSegment.photos(), idOf('sunset.avif')));
  await stageReady(page);
  await page.getByRole('button', { name: 'Show filmstrip' }).click();
  await expect(gallery(page)).toBeVisible();
  await shot(page, 'viewer.jpg');
});

test('editor, matched and neutral', async ({ page }) => {
  const photoId = idOf('AFXT2721.RAF');
  await openEditor(page, photoId);
  await shot(page, 'editor.jpg');

  // Both stored with history behind them, so Undo is lit in each and the pair differs by the grade alone.
  await storeColourProfile(photoId, 'none');
  for (const [profile, label, file] of [
    ['matched', 'Matched', 'editor-matched.jpg'],
    ['none', 'None', 'editor-neutral.jpg'],
  ] as const) {
    await storeColourProfile(photoId, profile);
    await openEditor(page, photoId);
    await expect(page.getByRole('combobox', { name: 'Colour profile' })).toHaveText(label);
    await shot(page, file);
  }
});

async function storeColourProfile(photoId: string, colourProfile: 'matched' | 'none'): Promise<void> {
  const edits = route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits());
  const { rev } = (await (await api.get(edits)).json()) as { rev: number };
  const stored = await api.put(edits, { data: { doc: { version: 1, colourProfile }, rev, session: 'landing-shots' } });
  expect(stored.ok(), await stored.text()).toBe(true);
}

test('settings', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  const details = page
    .getByRole('list', { name: 'Libraries' })
    .getByRole('listitem')
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Library settings' }) });
  await details.getByText('Library settings').click();
  await expect(details).toHaveAttribute('open', '');
  await shot(page, 'settings.jpg');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test('grid and viewer', async ({ page }) => {
    await openLibraryGrid(page);
    await shot(page, 'mobile-grid.jpg');

    await page.goto(route(PathSegment.photos(), idOf('DSC00853.ARW')));
    await stageReady(page);
    await shot(page, 'mobile-viewer.jpg');
  });
});

test('stack triage', async ({ page }) => {
  const stack = await api.post(route(PathSegment.api(), PathSegment.stacks()), {
    data: { photo_ids: [idOf('DSC00853.ARW'), idOf('DSC02981.ARW')] },
  });
  expect(stack.ok(), await stack.text()).toBe(true);
  await page.goto(route(PathSegment.photos(), idOf('DSC00853.ARW')));
  await page.getByRole('button', { name: 'Triage stack' }).click();
  await expect(page.getByRole('button', { name: 'Pick A' })).toBeEnabled({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Split' }).click();
  await expect(stage(page).getByRole('img')).toHaveCount(2, { timeout: 60_000 });
  await shot(page, 'triage.jpg');
});

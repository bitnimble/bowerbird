import { expect } from '@playwright/test';
import { VERSION, test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { PRECOMPILED_KEY } from '../../src/features/precompile/precompiled_key';

test.use({ precompiled: false });

test('a first visit precompiles every pipeline before the app opens, once per version', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(route(PathSegment.settings()));
  await expect(page.getByRole('heading', { name: 'Preparing the editor' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Preparing the editor' })).toBeVisible();

  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible({ timeout: 120_000 });
  // The app opens after a minute even while compiling carries on, and only a finished compile is remembered.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), PRECOMPILED_KEY), {
      timeout: 120_000,
    })
    .toBe(VERSION);

  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Preparing the editor' })).toHaveCount(0);
});

test('a device that precompiled an older version precompiles again', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, '0.0.1'), PRECOMPILED_KEY);
  await page.goto(route(PathSegment.settings()));
  await expect(page.getByRole('heading', { name: 'Preparing the editor' })).toBeVisible();
});

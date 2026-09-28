import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { PathSegment, route } from '../../../src/schemas/route';
import { setOnboardingComplete } from '../helpers';

const WELCOME = new RegExp(`${route(PathSegment.welcome())}$`);

// Settings are the worker's, so the files after this one on it are handed back onboarded
// however this ends.
test.afterAll(async ({ request }) => {
  await setOnboardingComplete(request, true);
});

test('the home page opens the welcome wizard until it is finished', async ({ page }) => {
  await setOnboardingComplete(page.request, false);
  await page.goto(route());
  await expect(page).toHaveURL(WELCOME);
  await expect(page.getByRole('heading', { name: 'Welcome to Bowerbird' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toHaveCount(0);

  // Next or Skip, depending on whether an earlier spec left a library.
  await page.getByRole('button', { name: /^(Next|Skip)$/ }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page).not.toHaveURL(WELCOME);

  await page.goto(route());
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(page).not.toHaveURL(WELCOME);
});

for (const entry of ['welcome', 'settings'] as const) {
  test(`${entry} opens shared connect flow with automatic originals enabled`, async ({ page }) => {
    await setOnboardingComplete(page.request, entry === 'settings');
    await page.route(`**${route(PathSegment.api(), PathSegment.replication(), PathSegment.replicas(), PathSegment.browse())}`, async (request) => {
      await request.fulfill({ json: {
        peer_id: 'peer000000000001',
        name: 'Desktop',
        clock_ms: Date.now(),
        clock_skew_ms: 0,
        libraries: [{ id: 'library1', name: 'Trip', photo_count: 12, read_only: false, replicating: true }],
      } });
    });
    await page.goto(entry === 'welcome' ? route(PathSegment.welcome()) : route(PathSegment.settings(), 'libraries'));
    await page.getByRole('button', { name: 'Connect to another Bowerbird' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect to another Bowerbird' });
    await dialog.getByRole('textbox', { name: 'Device address' }).fill('http://desktop:5173');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByText('12 photos', { exact: true })).toBeVisible();
    await dialog.getByRole('radio', { name: 'Trip' }).check();
    await dialog.getByRole('button', { name: 'Next' }).click();

    await expect(dialog.getByRole('checkbox', { name: 'Keep originals on this device' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Automatically send and fetch originals' })).toBeChecked();
  });
}

import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { setOnboardingComplete } from '../helpers';

const WELCOME = new RegExp(`${route(PathSegment.welcome())}$`);

// Settings are global, so the rest of the run is handed back onboarded however this ends.
test.afterAll(async ({ request }) => {
  await setOnboardingComplete(request, true);
});

test('the home page opens the welcome wizard until it is finished', async ({ page }) => {
  await setOnboardingComplete(page.request, false);
  await page.goto(route());
  await expect(page).toHaveURL(WELCOME);
  await expect(page.getByRole('heading', { name: 'Welcome to Bowerbird' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toHaveCount(0);

  // Whether the backup step is there depends on whether an earlier spec left a library.
  const finish = page.getByRole('button', { name: 'Finish setup' });
  while (!(await finish.isVisible())) await page.getByRole('button', { name: /^(Next|Skip)$/ }).click();
  await finish.click();
  await expect(page).not.toHaveURL(WELCOME);

  await page.goto(route());
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(page).not.toHaveURL(WELCOME);
});

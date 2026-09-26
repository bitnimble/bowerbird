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

import { test } from '@playwright/test';
import { setOnboardingComplete } from './helpers';

test('finish onboarding', async ({ request }) => {
  await setOnboardingComplete(request, true);
});

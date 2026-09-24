import { expect, test } from '@playwright/test';
import { PathSegment, route } from '../../src/schemas/route';
import { API_URL } from './fixture_library';

test('finish onboarding', async ({ request }) => {
  const response = await request.patch(`${API_URL}${route(PathSegment.api(), PathSegment.settings())}`, {
    data: { onboarding_complete: true },
  });
  expect(response.ok()).toBe(true);
});

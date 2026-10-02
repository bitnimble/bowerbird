import { afterEach, expect, jest, test } from 'bun:test';
import { z } from 'zod';
import { request } from '../request';
import { send } from '../transport';

afterEach(() => {
  jest.restoreAllMocks();
});

test('JSON requests identify interactive work by default', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  await request(z.object({}), 'GET', '/api/photos/photo');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-bowerbird-activity')).toBe(
    'interactive',
  );
});

test('HTTP background intent preserves cancellation and JSON bodies', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  const controller = new AbortController();
  await send(
    'POST',
    '/api/photos/neighbours',
    { id: 'photo' },
    {
      signal: controller.signal,
      activity: 'background',
    },
  );
  const init = fetch.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).get('x-bowerbird-activity')).toBe('background');
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  expect(init?.signal).toBe(controller.signal);
  expect(init?.body).toBe('{"id":"photo"}');
});

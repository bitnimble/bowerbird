import { afterEach, expect, jest, test } from 'bun:test';
import { z } from 'zod';
import { request } from '../request';
import { send } from '../transport';

const shell = globalThis as { __TAURI__?: { core: { invoke(command: string, args: unknown): Promise<unknown> } } };
afterEach(() => { delete shell.__TAURI__; jest.restoreAllMocks(); });

test('JSON requests identify interactive HTTP work by default', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  await request(z.object({}), 'GET', '/api/photos/photo');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-bowerbird-activity')).toBe('interactive');
});

test('HTTP background intent preserves cancellation and JSON bodies', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  const controller = new AbortController();
  await send('post:photos/neighbours', 'POST', '/api/photos/neighbours', { id: 'photo' }, {
    signal: controller.signal, activity: 'background',
  });
  const init = fetch.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).get('x-bowerbird-activity')).toBe('background');
  expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
  expect(init?.signal).toBe(controller.signal);
  expect(init?.body).toBe('{"id":"photo"}');
});

test.each(['interactive', 'background'] as const)('IPC carries %s activity to the proxy', async (activity) => {
  let captured: unknown;
  const head = new TextEncoder().encode(JSON.stringify({ status: 204, headers: {} }));
  const framed = new Uint8Array(4 + head.length);
  new DataView(framed.buffer).setUint32(0, head.length, true);
  framed.set(head, 4);
  shell.__TAURI__ = { core: { invoke: async (_command, args) => { captured = args; return framed.buffer; } } };
  await send('get:photos/photo', 'GET', '/api/photos/photo', undefined, { activity });
  const encoded = z.object({ request: z.string() }).parse(captured);
  expect(JSON.parse(encoded.request)).toMatchObject({ method: 'GET', path: '/api/photos/photo', activity });
});

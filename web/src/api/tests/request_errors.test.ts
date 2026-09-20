// What a failed request does, over each transport, when the failure carries no body.
import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { albumsApi } from '../albums';
import { ApiError } from '../request';
import { settingsApi } from '../settings';
import { PathSegment, route } from '../../../../src/schemas/route';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answers(status: number, body = '', headers: Record<string, string> = {}): void {
  globalThis.fetch = (async () =>
    new Response(body === '' ? null : body, { status, headers })) as unknown as typeof fetch;
}

describe('a failed request', () => {
  // The regression: the empty-body shortcut was read before the status, so anything that
  // failed without a body came back as `undefined` and never threw. A caller reads that as
  // an empty result and renders an empty library where it should render an error.
  test.each([500, 502, 503, 504])('throws on %i with no body', async (status) => {
    answers(status);
    await expect(settingsApi.get()).rejects.toBeInstanceOf(ApiError);
  });

  test('carries the status when there is no body to quote', async () => {
    answers(502);
    const error = (await settingsApi.get().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    // Not the empty string: `res.statusText` is what a transport does not carry.
    expect(error.message).toContain('502');
  });

  test('prefers the envelope the server sent', async () => {
    answers(404, JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such photo' } }), {
      'content-type': 'application/json',
    });
    const error = (await settingsApi.get().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('no such photo');
  });

  // 204 still means "nothing", and so does a 200 that carries nothing - the shortcut is
  // right, it was only in the wrong order.
  test.each([204, 200])('returns nothing for a bodiless %i', async (status) => {
    answers(status);
    await expect(albumsApi.delete('abcd1234')).resolves.toBeUndefined();
  });

  test('refuses a bodiless answer where the route promises one', async () => {
    answers(200);
    await expect(settingsApi.get()).rejects.toBeInstanceOf(z.ZodError);
  });
});

// The two transports do not reject alike, and only one of them rejects with an `Error`.
// A Tauri command returning `Result<_, String>` rejects with the bare string, so reading
// `.message` off it gave `undefined` - and the reason the Rust produced, which is the whole
// point of the message, was thrown away on the one screen where it is being read.
describe('a transport that never got an answer', () => {
  const global = globalThis as {
    __TAURI__?: { core?: { invoke?: (command: string, args: unknown) => Promise<unknown> } };
  };
  afterEach(() => {
    delete global.__TAURI__;
  });

  test('carries a string rejection through, as the shell produces', async () => {
    const why = `could not reach http://127.0.0.1:9999${route(PathSegment.api(), PathSegment.settings())}: Connection refused`;
    global.__TAURI__ = { core: { invoke: async () => Promise.reject(why) } };

    const error = (await settingsApi.get().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('Connection refused');
    expect(error.message).not.toContain('undefined');
  });

  test('and an Error rejection, as fetch produces', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;

    const error = (await settingsApi.get().catch((e: unknown) => e)) as ApiError;
    expect(error.message).toContain('Failed to fetch');
  });
});

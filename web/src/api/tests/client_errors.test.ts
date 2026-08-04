// What a failed request does, over each transport, when the failure carries no body.
import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError, api } from '../client';

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
    await expect(api.getSettings()).rejects.toBeInstanceOf(ApiError);
  });

  test('carries the status when there is no body to quote', async () => {
    answers(502);
    const error = (await api.getSettings().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    // Not the empty string, which is what `res.statusText` used to cover and a transport
    // does not carry.
    expect(error.message).toContain('502');
  });

  test('prefers the envelope the server sent', async () => {
    answers(404, JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such photo' } }), {
      'content-type': 'application/json',
    });
    const error = (await api.getSettings().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('no such photo');
  });

  // 204 still means "nothing", and so does a 200 that carries nothing - the shortcut is
  // right, it was only in the wrong order.
  test.each([204, 200])('returns nothing for a bodiless %i', async (status) => {
    answers(status);
    await expect(api.getSettings()).resolves.toBeUndefined();
  });
});

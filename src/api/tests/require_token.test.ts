import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { applyErrorHandler } from '../error_handler';
import { requireToken } from '../require_token';

function app(): Hono {
  const app = new Hono();
  app.use('*', requireToken('secret'));
  app.use('*', cors({ origin: (origin) => origin }));
  app.get('/api/libraries', (c) => c.json([]));
  applyErrorHandler(app);
  return app;
}

test.each<{ name: string; headers: Record<string, string> }>([
  { name: 'no header', headers: {} },
  { name: 'a wrong token', headers: { Authorization: 'Bearer secreT' } },
  { name: 'a longer token', headers: { Authorization: 'Bearer secret2' } },
  { name: 'the token without its scheme', headers: { Authorization: 'secret' } },
])('refuses a request with $name', async ({ headers }) => {
  const reply = await app().request('/api/libraries', { headers });
  expect(reply.status).toBe(401);
  expect(await reply.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
});

test('refuses a browser preflight, so no page learns the server is there', async () => {
  const reply = await app().request('/api/libraries', {
    method: 'OPTIONS',
    headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' },
  });
  expect(reply.status).toBe(401);
  expect(reply.headers.get('access-control-allow-origin')).toBeNull();
});

test('answers a request carrying the token', async () => {
  const reply = await app().request('/api/libraries', {
    headers: { Authorization: 'Bearer secret' },
  });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual([]);
});

const ORIGIN = 'http://127.0.0.1:4100';

test('signs the page in once, and answers its cookie from then on', async () => {
  const server = app();
  const signIn = await server.request(`${ORIGIN}/api/libraries?token=secret`);
  expect(signIn.status).toBe(302);
  expect(signIn.headers.get('location')).toBe(`${ORIGIN}/api/libraries`);
  const cookie = signIn.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('bowerbird_token_4100=secret');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Strict');

  const reply = await server.request(`${ORIGIN}/api/libraries`, {
    headers: { Cookie: cookie.split(';')[0]! },
  });
  expect(reply.status).toBe(200);
});

test.each<{ name: string; headers: Record<string, string> }>([
  { name: 'without a cookie', headers: {} },
  { name: 'with its current cookie', headers: { Cookie: 'bowerbird_token_4100=secret' } },
  { name: 'with a stale cookie', headers: { Cookie: 'bowerbird_token_4100=old-secret' } },
])(
  'signs a restored page in $name, preserving its query and removing the token',
  async ({ headers }) => {
    const server = app();
    const signIn = await server.request(
      `${ORIGIN}/api/libraries?view=grid&token=secret&filter=kept`,
      { headers },
    );

    expect(signIn.status).toBe(302);
    expect(signIn.headers.get('location')).toBe(`${ORIGIN}/api/libraries?view=grid&filter=kept`);
    expect(signIn.headers.get('cache-control')).toBe('no-store');
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBe('bowerbird_token_4100=secret');
    const reply = await server.request(signIn.headers.get('location')!, {
      headers: { Cookie: cookie! },
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual([]);
  },
);

test('keeps sign-in redirects on this server for a path starting with two slashes', async () => {
  const reply = await app().request(`${ORIGIN}//another.example/photo?token=secret&view=full`);
  expect(reply.status).toBe(302);
  expect(reply.headers.get('location')).toBe(`${ORIGIN}//another.example/photo?view=full`);
});

test.each<{ name: string; url: string; headers: Record<string, string> }>([
  { name: 'a wrong sign-in', url: `${ORIGIN}/?token=secreT`, headers: {} },
  {
    name: 'a wrong cookie',
    url: `${ORIGIN}/api/libraries`,
    headers: { Cookie: 'bowerbird_token_4100=secreT' },
  },
  {
    name: 'the cookie of a server on another port',
    url: `${ORIGIN}/api/libraries`,
    headers: { Cookie: 'bowerbird_token_4200=secret' },
  },
])('refuses $name', async ({ url, headers }) => {
  const reply = await app().request(url, { headers });
  expect(reply.status).toBe(401);
  expect(reply.headers.get('set-cookie')).toBeNull();
});

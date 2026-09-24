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
  const reply = await app().request('/api/libraries', { headers: { Authorization: 'Bearer secret' } });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual([]);
});

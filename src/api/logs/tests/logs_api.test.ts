import { afterAll, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { Logger } from '../../../logger';
import { PathSegment, route } from '../../../schemas/route';
import { ServerLogsSchema } from '../../../schemas/server_logs';
import type { AddressedPeer } from '../../../services/replication/peer_transport';
import { LogsApi } from '../logs_api';

const AT = route(PathSegment.api(), PathSegment.logs());

function buildApp(peers: AddressedPeer[] = []): Hono {
  const app = new Hono();
  app.route(
    AT,
    new LogsApi(
      () => 'Studio',
      () => peers,
    ).routes,
  );
  return app;
}

const peer = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request) =>
    new URL(request.url).pathname === AT
      ? Response.json({ name: 'NAS', lines: ['from the peer'] })
      : new Response(null, { status: 404 }),
});
afterAll(() => peer.stop(true));

it('answers with what this server has logged, under its device name', async () => {
  const out = spyOn(console, 'log').mockImplementation(() => {});
  try {
    new Logger('logs-test', 'debug').info('a line for the dialog');
  } finally {
    out.mockRestore();
  }
  const res = await buildApp().request(AT);
  expect(res.status).toBe(200);
  const body = ServerLogsSchema.parse(await res.json());
  expect(body.name).toBe('Studio');
  expect(body.lines.at(-1)).toEndWith('[logs-test] a line for the dialog');
});

it("fetches each peer's logs, and says which did not answer", async () => {
  const res = await buildApp([
    { peer_id: 'nas', name: 'NAS', address: `http://127.0.0.1:${peer.port}/` },
    { peer_id: 'gone', name: 'Old laptop', address: 'http://127.0.0.1:1' },
  ]).request(route(PathSegment.api(), PathSegment.logs(), PathSegment.peers()));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    peers: [
      { peer_id: 'nas', name: 'NAS', lines: ['from the peer'] },
      { peer_id: 'gone', name: 'Old laptop', lines: null },
    ],
  });
});

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stagePayload } from '../update_service';

const home = mkdtempSync(path.join(tmpdir(), 'bowerbird-stage-home-'));
let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(home, { recursive: true, force: true });
});

test('a download the release does not have stages nothing', async () => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no such file', { status: 404 }) });
  const origin = `http://127.0.0.1:${server.port}`;

  await expect(
    stagePayload(home, { url: `${origin}/gone.tar.gz`, filename: 'gone.tar.gz', sha256: 'c'.repeat(64), version: '0.2.0' }),
  ).rejects.toThrow(/404/);
  expect(existsSync(path.join(home, 'staged.version'))).toBe(false);
});

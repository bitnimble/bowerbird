import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import path from 'node:path';
import { test as base } from '@playwright/test';
import { PathSegment, route } from '../../src/schemas/route';
import { E2E_ROOT } from './fixture_library';
import { resetViewerSettings } from './helpers';

const WEB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = path.resolve(WEB, '..');

/**
 * A worker's own API, catalogue and Vite, so the workers share nothing but the fixture roots on
 * disk: the viewer's rendition mode, the sidebar setting and onboarding are the server's, and a
 * file on one worker changing one would change it under a file on the other.
 */
export const test = base.extend<{ freshViewer: void }, { instance: string }>({
  // The viewer's settings are the worker's, so one test choosing a rendition or keeping the
  // sidebar would reach the next test on it, whichever file that is.
  freshViewer: [
    async ({ request }, use) => {
      await resetViewerSettings(request);
      await use();
    },
    { auto: true },
  ],
  instance: [
    // Playwright reads a fixture's dependencies off this pattern and refuses anything else.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const dir = instanceDir(workerInfo.parallelIndex);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const [apiPort, webPort] = [await freePort(), await freePort()];
      const api = `http://127.0.0.1:${apiPort}`;
      const web = `http://127.0.0.1:${webPort}`;
      const servers = [
        start(['bun', 'run', 'src/index.ts'], REPO, {
          DB_PATH: path.join(dir, 'e2e.db'),
          // Unset, it is `./data` under the API's working directory, which is the checkout.
          DATA_DIR: path.join(dir, 'data'),
          PORT: String(apiPort),
          HOST: '127.0.0.1',
          // Left on, every sidebar grows a row the moment a release exists newer than whatever
          // `package.json` says here, and the suite would start depending on what is published.
          BOWERBIRD_UPDATE_REPO: '',
        }),
        start(['bun', 'run', '../scripts/vite.ts', '--config', 'e2e/vite.config.ts', '--port', String(webPort)], WEB, {
          VITE_API_URL: api,
          E2E_VITE_CACHE_DIR: path.join(WEB, 'node_modules', `.vite-e2e-${workerInfo.parallelIndex}`),
        }),
      ];
      try {
        await Promise.all([
          upAt(`${api}${route(PathSegment.api(), PathSegment.libraries())}`, servers[0]!),
          upAt(web, servers[1]!),
        ]);
        const onboarded = await fetch(`${api}${route(PathSegment.api(), PathSegment.settings())}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ onboarding_complete: true }),
        });
        if (!onboarded.ok) throw new Error(`could not finish onboarding: ${await onboarded.text()}`);
        await use(web);
      } finally {
        await Promise.all(servers.map(stop));
      }
    },
    { scope: 'worker', auto: true, timeout: 180_000 },
  ],
  baseURL: async ({ instance }, use) => {
    await use(instance);
  },
});

/** Where a library's renditions land, in the running test's worker. */
export function libraryDataDir(libraryId: string): string {
  return path.join(instanceDir(test.info().parallelIndex), 'data', libraryId);
}

// By slot rather than by worker, so a worker restarted after a failure takes over its
// predecessor's directory instead of leaving one behind per failure.
function instanceDir(parallelIndex: number): string {
  return path.join(E2E_ROOT, 'instances', String(parallelIndex));
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

function start(command: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const [program = '', ...args] = command;
  // Its own process group, so stopping it takes whatever it spawned too: `scripts/vite.ts`
  // re-executes itself under a flag.
  return spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'], detached: true });
}

async function upAt(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`the server for ${url} exited with ${server.exitCode}`);
    const answered = await fetch(url).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`nothing answered at ${url}`);
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.pid == null || server.exitCode != null) return;
  const exited = once(server, 'exit');
  process.kill(-server.pid, 'SIGTERM');
  await exited;
}

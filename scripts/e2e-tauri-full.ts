// The servers the desktop suite talks to.
//
// Five of its nine specs need a running Bowerbird and skip themselves without one, and a spec
// that skips reports the same green as a spec that passes. The one covering the whole reason
// the desktop build exists - a RAW decoded in the shell process - sat skipped that way and was
// timing out the moment it ran. So `e2e:tauri` stands these up rather than offering them as an
// opt-in nobody would remember to take.
//
// Two of them: one holds a library with a photo in it, for the round trip, and the second
// exists only for the case that moves between libraries.
import { spawn, type Subprocess } from 'bun';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'test/fixtures/DSC02981.ARW');
const PORTS = [24801, 24802];

// Its own, not the Playwright run's: sharing that would make this suite pass or fail on
// whether the other one had been run, and in which order.
const SHELL_ROOT = join(tmpdir(), 'bowerbird-e2e-shell');
const PHOTOS = join(SHELL_ROOT, 'photos');

function serve(dbPath: string, port: number): Subprocess {
  return spawn(['bun', 'run', 'src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'warn' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

async function get(url: string): Promise<unknown | null> {
  try {
    const reply = await fetch(url);
    return reply.ok ? await reply.json() : null;
  } catch {
    return null;
  }
}

async function until<T>(what: string, poll: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const answer = await poll();
    if (answer != null) return answer;
    await Bun.sleep(500);
  }
  throw new Error(`${what} never happened`);
}

rmSync(SHELL_ROOT, { recursive: true, force: true });
mkdirSync(PHOTOS, { recursive: true });
await Bun.write(join(PHOTOS, 'alpha.arw'), Bun.file(FIXTURE));

const servers = [serve(join(SHELL_ROOT, 'shell.db'), PORTS[0]!), serve(join(SHELL_ROOT, 'second.db'), PORTS[1]!)];
const origins = PORTS.map((port) => `http://127.0.0.1:${port}`);

try {
  for (const origin of origins) await until(`${origin} answering`, () => get(`${origin}/api/libraries`));

  const created = await fetch(`${origins[0]}/api/libraries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root_path: PHOTOS }),
  });
  if (!created.ok) throw new Error(`could not add the library: ${created.status} ${await created.text()}`);
  const library = (await created.json()) as { id: string };

  await fetch(`${origins[0]}/api/libraries/${library.id}/sync`, { method: 'POST' });
  // The suite reads a photo id off this list, and skips itself if the list is empty - which
  // it is until the scan has walked the root.
  await until('the fixture photo importing', async () => {
    const listed = (await get(`${origins[0]}/api/libraries/${library.id}/photos?limit=1`)) as
      | { photos: unknown[] }
      | null;
    return listed != null && listed.photos.length > 0 ? listed : null;
  });

  const wdio = spawn(['xvfb-run', '-a', './node_modules/.bin/wdio', 'run', 'wdio.conf.ts'], {
    cwd: ROOT,
    env: { ...process.env, BOWERBIRD_E2E_SERVER: origins[0]!, BOWERBIRD_E2E_SERVER_2: origins[1]! },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exitCode = await wdio.exited;
} finally {
  for (const server of servers) server.kill();
}

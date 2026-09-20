// Starts a server binary (or entry script) on a scratch catalogue and reports what
// it can answer, which is the only way to tell a compiled bundle that starts from
// one that can actually decode a photograph.
//
// `bun run scripts/probe-server.ts <command...>`
import { spawn } from 'bun';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(tmpdir(), `bowerbird-probe-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'data'), { recursive: true });
mkdirSync(join(root, 'photos'), { recursive: true });

// A real RAW, so the scan has something to decode and the native library is
// actually reached rather than merely present.
const FIXTURE = join(import.meta.dir, '..', 'test', 'fixtures', 'DSC02981.ARW');
if (existsSync(FIXTURE)) copyFileSync(FIXTURE, join(root, 'photos', 'probe.arw'));
else console.log('no RAW fixture, so this run proves startup and the scan but not the decoder');

const port = 24000 + (process.pid % 1000);
const command = process.argv.slice(2);
if (command.length === 0) throw new Error('usage: probe-server.ts <command...>');

const server = spawn(command, {
  env: {
    ...process.env,
    DB_PATH: join(root, 'probe.db'),
    DATA_DIR: join(root, 'data'),
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

const origin = `http://127.0.0.1:${port}`;

async function answered(path: string): Promise<Response | null> {
  try {
    return await fetch(`${origin}${path}`);
  } catch {
    return null;
  }
}

try {
  let up: Response | null = null;
  for (let attempt = 0; attempt < 60 && up == null; attempt++) {
    up = await answered('/api/libraries');
    if (up == null) await Bun.sleep(250);
  }
  if (up == null) throw new Error('the server never answered');
  console.log(`GET /api/libraries -> ${up.status}`);

  // A library exercises the scan, which is where the worker threads and the native
  // library are actually reached from.
  const created = await fetch(`${origin}/api/libraries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root_path: join(root, 'photos') }),
  });
  console.log(`POST /api/libraries -> ${created.status}`);
  if (!created.ok) throw new Error(await created.text());
  const library = (await created.json()) as { id: string };

  // Adding a library starts one of its own, so "already running" is the same good
  // news as "started": either way the scan reached its worker threads.
  const synced = await fetch(`${origin}/api/libraries/${library.id}/sync`, { method: 'POST' });
  const body = await synced.text();
  const running = synced.ok || body.includes('SYNC_IN_PROGRESS');
  console.log(`POST sync -> ${synced.status}${synced.ok ? '' : ' (a scan was already under way)'}`);
  if (!running) throw new Error(body);

  // And the decoder itself, which a scan of an empty folder never reaches: the FFI
  // is opened lazily, so nothing up to here has proved the native library was even
  // found. A real RAW read through to a catalogued photograph is the proof.
  for (let attempt = 0; attempt < 120; attempt++) {
    const listed = await fetch(`${origin}/api/libraries/${library.id}/photos?limit=1`);
    const photos = (await listed.json()) as { photos?: unknown[] };
    if ((photos.photos ?? []).length > 0) {
      console.log('a RAW was decoded and catalogued: the native library loaded');
      break;
    }
    if (attempt === 119) throw new Error('the scan never catalogued the RAW, so the native library never loaded');
    await Bun.sleep(250);
  }
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}

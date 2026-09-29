// Starts a server binary (or entry script) on a scratch catalogue and reports what
// it can answer, which is the only way to tell a compiled bundle that starts from
// one that can actually decode a photograph.
//
// `bun run scripts/probe-server.ts <command...>`
import { spawn } from 'bun';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibrarySchema, LibraryScanStatusSchema } from '../src/schemas/libraries';
import { ActivitySnapshotSchema } from '../src/schemas/activity';
import { PhotoListResponseSchema } from '../src/schemas/photos';
import type { UpdateSettingsRequest } from '../src/schemas/settings';

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

async function waitForPhoto(libraryId: string, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const listed = await fetch(`${origin}/api/libraries/${libraryId}/photos?limit=10`);
    if (!listed.ok) throw new Error(await listed.text());
    const photos = PhotoListResponseSchema.parse(await listed.json());
    if (photos.photos.some((photo) => photo.file_path === filePath)) {
      const status = await fetch(`${origin}/api/libraries/${libraryId}/sync/status`);
      if (!status.ok) throw new Error(await status.text());
      if (LibraryScanStatusSchema.parse(await status.json()).status === 'idle') return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`the server never catalogued ${filePath} and settled its scan`);
}

try {
  let up: Response | null = null;
  for (let attempt = 0; attempt < 60 && up == null; attempt++) {
    up = await answered('/api/libraries');
    if (up == null) await Bun.sleep(250);
  }
  if (up == null) throw new Error('the server never answered');
  console.log(`GET /api/libraries -> ${up.status}`);

  const configured = await fetch(`${origin}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      watch_enabled: true,
      watch_debounce_ms: 150,
      full_sync_at: '',
    } satisfies UpdateSettingsRequest),
  });
  if (!configured.ok) throw new Error(await configured.text());

  // A library exercises the scan, which is where the worker threads and the native
  // library are actually reached from.
  const created = await fetch(`${origin}/api/libraries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      root_path: join(root, 'photos'),
      auto_stack: false,
      rendition_source: 'embedded',
    }),
  });
  console.log(`POST /api/libraries -> ${created.status}`);
  if (!created.ok) throw new Error(await created.text());
  const library = LibrarySchema.parse(await created.json());

  // Adding a library starts one of its own, so "already running" is the same good
  // news as "started": either way the scan reached its worker threads.
  const synced = await fetch(`${origin}/api/libraries/${library.id}/sync`, { method: 'POST' });
  const body = await synced.text();
  const running = synced.ok || body.includes('SYNC_IN_PROGRESS');
  console.log(`POST sync -> ${synced.status}${synced.ok ? '' : ' (a scan was already under way)'}`);
  if (!running) throw new Error(body);

  await waitForPhoto(library.id, 'probe.arw');
  console.log('a RAW was decoded and catalogued: the native library loaded');

  const arriving = join(root, 'photos', 'watched.arw.part');
  copyFileSync(FIXTURE, arriving);
  renameSync(arriving, join(root, 'photos', 'watched.arw'));
  await waitForPhoto(library.id, 'watched.arw');
  console.log('watcher imported watched.arw without a manual scan');
  const activity = await fetch(`${origin}/api/libraries/activity`);
  if (!activity.ok) throw new Error(await activity.text());
  const snapshot = ActivitySnapshotSchema.parse(await activity.json());
  const imported = snapshot.libraries.find((each) => each.id === library.id);
  if (
    imported == null ||
    imported.photo_count !== 2 ||
    imported.missing_photo_count !== 0 ||
    imported.unavailable_photo_count !== 0 ||
    imported.rendered_photo_count !== 0
  ) {
    throw new Error(`unexpected imported library counts: ${JSON.stringify(imported)}`);
  }
  console.log('activity snapshot reports 2 photos, 0 missing, 0 unavailable, 0 rendered');
} finally {
  server.kill();
  rmSync(root, { recursive: true, force: true });
}

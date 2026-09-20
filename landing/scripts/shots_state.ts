import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export const SHOTS_DIR = path.join(REPO, 'landing/public/shots');
const STATE_ROOT = path.join(tmpdir(), 'bowerbird-landing-shots');
export const LIBRARY_ROOT = path.join(STATE_ROOT, 'Bowerbird');
export const DB_PATH = path.join(STATE_ROOT, 'shots.db');
export const DATA_DIR = path.join(STATE_ROOT, 'data');

// Public assets only: the site these land on is public, and nothing else may appear in a shot.
const LIBRARY: Record<string, [from: string, to: string][]> = {
  Fujifilm: [
    ['test/fixtures/AFXT2721.RAF', 'AFXT2721.RAF'],
    ['test/fixtures/DSCF8146.RAF', 'DSCF8146.RAF'],
  ],
  Sony: [
    ['test/fixtures/DSC00853.ARW', 'DSC00853.ARW'],
    ['test/fixtures/DSC02981.ARW', 'DSC02981.ARW'],
  ],
  Canon: [['test/fixtures/IMG_5360.CR3', 'IMG_5360.CR3']],
  HDR: [
    ['web/public/hdr/arches-hdr.avif', 'arches.avif'],
    ['web/public/hdr/rapids-hdr.avif', 'rapids.avif'],
    ['web/public/hdr/sunset-hdr.avif', 'sunset.avif'],
  ],
};
export const PHOTO_COUNT = Object.values(LIBRARY).flat().length;

// Published through the environment so the workers Playwright forks call the servers the config started.
function runPort(name: string): number {
  const published = process.env[name];
  if (published != null && published !== '') return Number(published);
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env[name] = String(port);
  return port;
}

export const API_PORT = runPort('SHOTS_API_PORT');
export const WEB_PORT = runPort('SHOTS_WEB_PORT');
export const API_URL = `http://127.0.0.1:${API_PORT}`;

export function prepareState(): void {
  if (process.env.SHOTS_STATE_READY === '1') return;
  process.env.SHOTS_STATE_READY = '1';
  rmSync(STATE_ROOT, { recursive: true, force: true });
  for (const [shoot, files] of Object.entries(LIBRARY)) {
    mkdirSync(path.join(LIBRARY_ROOT, shoot), { recursive: true });
    for (const [from, to] of files) copyFileSync(path.join(REPO, from), path.join(LIBRARY_ROOT, shoot, to));
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
}

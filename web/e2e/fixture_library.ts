import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// A throwaway library root + DB per run, so E2E never touches a real catalogue
// and a rerun starts from a known-empty state.
export const E2E_ROOT = '/tmp/bowerbird-e2e';
// One library root per spec file. The whole run shares a single API and DB, so
// specs that mutate a catalogue (binning, moving into shoots) would otherwise
// see each other's changes and depend on file order.
export const PHOTOS_DIR = path.join(E2E_ROOT, 'photos');
export const CULL_PHOTOS_DIR = path.join(E2E_ROOT, 'cull-photos');
export const NATIVE_PHOTOS_DIR = path.join(E2E_ROOT, 'native-photos');
export const DB_PATH = path.join(E2E_ROOT, 'e2e.db');
export const API_PORT = 3111;
export const WEB_PORT = 5199;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), '../../test/fixtures/DSC02981.ARW');

// Two copies under different names: enough to prove the grid, selection and
// paging work, without a 24MB decode per extra frame.
export const PHOTO_NAMES = ['alpha.arw', 'beta.arw'];

// Called from playwright.config.ts at import time, not from globalSetup: the
// webServers launch before globalSetup runs, and the API cannot open its DB
// until this directory exists.
export function prepareFixture(): void {
  rmSync(E2E_ROOT, { recursive: true, force: true });
  for (const dir of [PHOTOS_DIR, CULL_PHOTOS_DIR, NATIVE_PHOTOS_DIR]) {
    mkdirSync(dir, { recursive: true });
    for (const name of PHOTO_NAMES) copyFileSync(FIXTURE, path.join(dir, name));
  }
}

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const E2E_DIR = path.dirname(new URL(import.meta.url).pathname);

// A throwaway library root + DB per run, so E2E never touches a real catalogue
// and a rerun starts from a known-empty state. Keyed by checkout so parallel
// worktrees don't wipe each other's fixture mid-run, but stable across reruns
// of one checkout so the copies are overwritten rather than piling up in /tmp.
const CHECKOUT_KEY = createHash('sha1').update(path.resolve(E2E_DIR, '../..')).digest('hex').slice(0, 8);
export const E2E_ROOT = path.join(tmpdir(), `bowerbird-e2e-${CHECKOUT_KEY}`);
// One library root per spec file. The whole run shares a single API and DB, so
// specs that mutate a catalogue (binning, moving into shoots) would otherwise
// see each other's changes and depend on file order.
export const PHOTOS_DIR = path.join(E2E_ROOT, 'photos');
export const CULL_PHOTOS_DIR = path.join(E2E_ROOT, 'cull-photos');
export const STACK_PHOTOS_DIR = path.join(E2E_ROOT, 'stack-photos');
export const PHONE_PHOTOS_DIR = path.join(E2E_ROOT, 'phone-photos');
// Triage writes a verdict onto every member it judges, so it gets a library of
// its own rather than leaving the stacks spec's frames triaged behind it.
export const TRIAGE_PHOTOS_DIR = path.join(E2E_ROOT, 'triage-photos');
// The editor writes an exposure, a crop and a turn onto the photo it opens, and a
// root can only be added once against the shared DB - so it gets its own rather
// than leaving another spec's frames edited behind it.
export const EDIT_PHOTOS_DIR = path.join(E2E_ROOT, 'edit-photos');
// The read-only spec bins and restores, and its whole point is that the tree it
// does that over is untouched afterwards - which another spec's frames moving
// around in it would make unassertable.
export const ARCHIVE_PHOTOS_DIR = path.join(E2E_ROOT, 'archive-photos');
// The wasm decode only reads, but a root can only be added once against the shared
// DB - so sharing the editor's would make whichever spec ran second fail to add it.
export const DECODE_PHOTOS_DIR = path.join(E2E_ROOT, 'decode-photos');
export const DECODE_PHOTO_NAMES = ['alpha.arw'];
export const DB_PATH = path.join(E2E_ROOT, 'e2e.db');
// Every generated file, outside every library root (§3). Under the fixture rather
// than left to default: `./data` is relative to the API's cwd, which is the
// checkout, so an unset DATA_DIR fills the working tree with the run's renditions
// and leaves them there.
export const DATA_DIR = path.join(E2E_ROOT, 'data');

/** Where a library's renditions land, which is keyed by its id rather than by its root. */
export function libraryDataDir(libraryId: string): string {
  return path.join(DATA_DIR, libraryId);
}
// Playwright has to know both URLs before it launches anything, so these can't
// be port 0 - pick one and publish it. The config process picks first and the
// worker processes it forks inherit the choice through the environment, which is
// what keeps the API_URL the specs call on the one the API was started on.
function runPort(name: string): number {
  const published = process.env[name];
  if (published != null && published !== '') return Number(published);
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env[name] = String(port);
  return port;
}

export const API_PORT = runPort('E2E_API_PORT');
export const WEB_PORT = runPort('E2E_WEB_PORT');
export const API_URL = `http://127.0.0.1:${API_PORT}`;

const FIXTURE = path.join(E2E_DIR, '../../test/fixtures/DSC02981.ARW');

// Two copies under different names: enough to prove the grid, selection and
// paging work, without a 24MB decode per extra frame.
export const PHOTO_NAMES = ['alpha.arw', 'beta.arw'];

// The stacks library gets a third. Triage is a tournament, and two photos is a
// single round: it cannot show a winner being held over, a second entry in the
// queue, or a rewind to anything but the start. Its own list rather than a longer
// PHOTO_NAMES, which the catalogue and culling specs count tiles against.
export const STACK_PHOTO_NAMES = [...PHOTO_NAMES, 'gamma.arw'];

// Triage gets a fourth. Three is enough for a tournament, but not for a round
// whose *both* frames are new to the stage: a decisive verdict always carries its
// winner over, and with three the round after a draw still holds one frame the
// stage already had. Two fresh frames, both warm, both decoding in one batch is
// the case where a promotion that reads stale state loses one of them.
export const TRIAGE_PHOTO_NAMES = [...STACK_PHOTO_NAMES, 'delta.arw'];

// Called from playwright.config.ts at import time, not from globalSetup: the
// webServers launch before globalSetup runs, and the API cannot open its DB
// until this directory exists.
//
// Once per run, not once per import. The config is imported again by every worker
// process - one per project - and each of those wiped the root out from under the
// run already in progress, which a spec that writes its own library only survived
// by luck. The flag travels to the workers the same way the ports do.
export function prepareFixture(): void {
  if (process.env.E2E_FIXTURE_READY === '1') return;
  process.env.E2E_FIXTURE_READY = '1';
  console.log(`E2E API on ${API_URL}, web on http://127.0.0.1:${WEB_PORT}, fixture in ${E2E_ROOT}`);
  rmSync(E2E_ROOT, { recursive: true, force: true });
  // The stacks library gets the same copies as the others. Every frame being
  // byte-identical is what makes it a stack: detection has nothing to tell them
  // apart, which is the correct answer and the reason the other libraries turn
  // it off (`addLibrary`).
  const namesFor = (dir: string): string[] =>
    dir === TRIAGE_PHOTOS_DIR
      ? TRIAGE_PHOTO_NAMES
      : dir === STACK_PHOTOS_DIR
        ? STACK_PHOTO_NAMES
        : // One frame, because a sync is a real decode and this library is only ever asked for
          // the bytes of a single photo.
          dir === DECODE_PHOTOS_DIR
          ? DECODE_PHOTO_NAMES
          : PHOTO_NAMES;
  for (const dir of [
    PHOTOS_DIR,
    CULL_PHOTOS_DIR,
    STACK_PHOTOS_DIR,
    PHONE_PHOTOS_DIR,
    TRIAGE_PHOTOS_DIR,
    EDIT_PHOTOS_DIR,
    ARCHIVE_PHOTOS_DIR,
    DECODE_PHOTOS_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
    for (const name of namesFor(dir)) copyFileSync(FIXTURE, path.join(dir, name));
  }
}

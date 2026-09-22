import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PANORAMA_VIEW_NAMES, panoramaViews } from '../../scripts/pano-views';
import { PathSegment, route } from '../../src/schemas/route';

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
export const STACK_PHOTOS_DIR = path.join(E2E_ROOT, 'stack-photos');
// The grid's own, one per spec: verdicts, a selection, a filter and a bin all
// write to the catalogue, and a count asserted in one of them is a count another
// would move.
export const GRID_PHOTOS_DIR = path.join(E2E_ROOT, 'grid-photos');
export const SELECT_PHOTOS_DIR = path.join(E2E_ROOT, 'select-photos');
export const FILTER_PHOTOS_DIR = path.join(E2E_ROOT, 'filter-photos');
export const BIN_PHOTOS_DIR = path.join(E2E_ROOT, 'bin-photos');
export const THUMBNAIL_PHOTOS_DIR = path.join(E2E_ROOT, 'thumbnail-photos');
export const LAYOUT_PHOTOS_DIR = path.join(E2E_ROOT, 'layout-photos');
export const URL_PHOTOS_DIR = path.join(E2E_ROOT, 'url-photos');
// The second library that spec opens: what it proves is that a question asked of
// one collection is not carried into the next, which needs a next.
export const URL_OTHER_PHOTOS_DIR = path.join(E2E_ROOT, 'url-other-photos');
// A library indexed by the spec that watches it being indexed, so it has to
// arrive empty of everything including itself.
export const INDEX_PHOTOS_DIR = path.join(E2E_ROOT, 'index-photos');
// The shell measures where a library's tiles sit against the window.
export const SHELL_PHOTOS_DIR = path.join(E2E_ROOT, 'shell-photos');
// The viewer's, and the reason these are five rather than one is the library's
// rendition source: four of them switch it to a render, and the fifth asserts
// what a library serving the camera's JPEG says about the file it is showing.
export const VIEWER_PHOTOS_DIR = path.join(E2E_ROOT, 'viewer-photos');
// Drawing an HDR rendition, which is the one thing here that needs the frame's planes on a
// real GPU rather than an import - so it renders, and cannot share a root with a spec that
// leaves its library on the camera's JPEG. The standard pair rather than one frame: the count
// is what `useLibrary` waits the sync out against.
export const HDR_PHOTOS_DIR = path.join(E2E_ROOT, 'hdr-photos');
export const RENDITION_PHOTOS_DIR = path.join(E2E_ROOT, 'rendition-photos');
export const FRAME_PHOTOS_DIR = path.join(E2E_ROOT, 'frame-photos');
export const ZOOM_PHOTOS_DIR = path.join(E2E_ROOT, 'zoom-photos');
export const PHONE_PHOTOS_DIR = path.join(E2E_ROOT, 'phone-photos');
// Triage writes a verdict onto every member it judges, so it gets a library of
// its own rather than leaving the stacks spec's frames triaged behind it.
export const TRIAGE_PHOTOS_DIR = path.join(E2E_ROOT, 'triage-photos');
// The editor writes an exposure, a crop and a turn onto the photo it opens, and a
// root can only be added once against the shared DB - so it gets its own rather
// than leaving another spec's frames edited behind it.
export const EDIT_PHOTOS_DIR = path.join(E2E_ROOT, 'edit-photos');
export const MOBILE_EDIT_PHOTOS_DIR = path.join(E2E_ROOT, 'mobile-edit-photos');
// The viewer's print mockup opens the same editor session the grade does, so it gets a
// root of its own rather than reading whatever the editor's spec left behind on its frames.
export const PRINT_PHOTOS_DIR = path.join(E2E_ROOT, 'print-photos');
// The read-only spec bins and restores, and its whole point is that the tree it
// does that over is untouched afterwards - which another spec's frames moving
// around in it would make unassertable.
export const ARCHIVE_PHOTOS_DIR = path.join(E2E_ROOT, 'archive-photos');
// The wasm decode only reads, but a root can only be added once against the shared
// DB - so sharing the editor's would make whichever spec ran second fail to add it.
export const DECODE_PHOTOS_DIR = path.join(E2E_ROOT, 'decode-photos');
export const DECODE_PHOTO_NAMES = ['alpha.arw'];
// Viewing without WebGPU, which runs in a browser launched without it, so it cannot share a
// root with a spec that has one.
export const FALLBACK_PHOTOS_DIR = path.join(E2E_ROOT, 'fallback-photos');
// The X-Trans root, and the other one whose files are not copies of the RAW fixture: every other
// library here is a Bayer sensor, which is the pattern with a 2x2 site and so the one that exercises
// none of the demultiplexing. Its own root because it is the only library in the run whose
// photographs are not interchangeable with the rest.
export const XTRANS_PHOTOS_DIR = path.join(E2E_ROOT, 'xtrans-photos');
export const XTRANS_PHOTO_NAMES = ['xtrans.raf'];
// The panorama's, and it is the one root whose files are not copies of the RAW fixture: a
// composite needs frames that overlap, and no RAW fixture is a pan. Six synthetic views of one
// world instead, written by the crate that aligns them (`scripts/pano-views.ts`).
//
// Its own root for the ordinary reason and one of its own: merging writes a composite row into
// the library, so a spec counting photographs in a shared root would see a seventh appear.
export const PANORAMA_PHOTOS_DIR = path.join(E2E_ROOT, 'panorama-photos');
export const PANORAMA_PHOTO_NAMES = PANORAMA_VIEW_NAMES;
// The merge page's own root, for the panorama's reason and one of its own: Done inserts a
// photograph, so a spec counting rows in a shared root would see one appear. A burst rather than
// copies of one frame - a tile only exists where the frames differ, and no shipped RAW fixture is
// a burst - written by `synth_raw --burst`, a crowd whose figures move between frames under a
// moving camera.
export const MERGE_PHOTOS_DIR = path.join(E2E_ROOT, 'merge-photos');
export const MERGE_PHOTO_NAMES = ['frame-0.dng', 'frame-1.dng', 'frame-2.dng'];
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

// A stack's members. The sort is required rather than defaulted, so that a caller
// cannot get back an order nothing else in the app uses (§19.5.3); these fixtures
// only ever count and filter, so the libraries' own default answers.
export function stackPhotosUrl(stackId: string): string {
  return `${API_URL}${route(PathSegment.api(), PathSegment.stacks(), stackId, PathSegment.photos())}?ordering=taken_asc`;
}

const FIXTURE = path.join(E2E_DIR, '../../test/fixtures/DSC02981.ARW');
const XTRANS_FIXTURE = path.join(E2E_DIR, '../../test/fixtures/AFXT2721.RAF');
// The panorama's six. A composite needs frames that overlap and no RAW fixture is a pan, so these
// are rendered by the crate that aligns them - once per checkout, into a directory outside the
// run's own root so a rerun copies rather than renders.
const PANORAMA_VIEWS = path.join(E2E_DIR, '../../test/fixtures/pano-views');

// The burst, kept beside the panorama's views and for the same reason: written once per checkout
// outside the root this run wipes, then copied in.
const MERGE_BURST = path.join(E2E_DIR, '../../test/fixtures/merge-burst');
const REPO_ROOT = path.join(E2E_DIR, '../..');

/**
 * Three DNGs of a crowd from a moving camera, each carrying the embedded preview the align opens a
 * source through.
 *
 * A crowd rather than a textured test chart: the align matches corners, and a chart's zone plates
 * alias into matches that fail the burst's corner check.
 *
 * Small, because what the spec asks of them is that a tile exists at all: the analysis scale is
 * what the page draws at, and a 24MP burst would spend a minute of the run proving nothing extra.
 */
function mergeBurst(directory: string): void {
  const frames = MERGE_PHOTO_NAMES.map((name) => path.join(directory, name));
  if (frames.every((at) => existsSync(at))) return;
  mkdirSync(directory, { recursive: true });
  // Written aside and the DNGs alone copied in: the burst puts a JPEG beside each frame.
  const scratch = path.join(tmpdir(), `bowerbird-merge-burst-${process.pid}`);
  const run = spawnSync(
    'bun',
    [
      'run',
      path.join(REPO_ROOT, 'scripts/cargo.ts'),
      'run',
      '--profile',
      'quick',
      '--manifest-path',
      path.join(REPO_ROOT, 'native/rawshim/Cargo.toml'),
      '--example',
      'synth_raw',
      '--',
      path.join(scratch, 'unused.dng'),
      '--burst',
      scratch,
      '--frames',
      String(MERGE_PHOTO_NAMES.length),
      '--width',
      '1200',
      '--height',
      '800',
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (run.status !== 0) throw new Error(`could not write the merge burst into ${scratch}`);
  for (const name of MERGE_PHOTO_NAMES) copyFileSync(path.join(scratch, name), path.join(directory, name));
  rmSync(scratch, { recursive: true, force: true });
}

// Two copies under different names: enough to prove the grid, selection and
// paging work, without a 24MB decode per extra frame.
export const PHOTO_NAMES = ['alpha.arw', 'beta.arw'];

// The stacks library gets a third. Triage is a tournament, and two photos is a
// single round: it cannot show a winner being held over, a second entry in the
// queue, or a rewind to anything but the start. Its own list rather than a longer
// PHOTO_NAMES, which the shoots and grid specs count tiles against.
export const STACK_PHOTO_NAMES = [...PHOTO_NAMES, 'gamma.arw'];

// The selection library gets four, and its own list for the reason the stacks
// one has its own: with two tiles a span between the ends and a click on each end
// select the same pair, so no count can tell a range apart from a wrong one. Four
// leaves a middle to be inside a span and outside the next.
export const SELECT_PHOTO_NAMES = ['alpha.arw', 'beta.arw', 'gamma.arw', 'delta.arw'];

// Triage gets a fourth. Three is enough for a tournament, but not for a round
// whose *both* frames are new to the stage: a decisive verdict always carries its
// winner over, and with three the round after a draw still holds one frame the
// stage already had. Two fresh frames, both warm, both decoding in one batch is
// the case where a promotion that reads stale state loses one of them.
export const TRIAGE_PHOTO_NAMES = [...STACK_PHOTO_NAMES, 'delta.arw'];

// The address bar spec gets four, and its own list rather than the triage one it
// happens to match: two frames in a window short enough to scroll them at all
// still leave the reader inside the first row, and a position that never leaves
// row zero is not one to put back.
export const URL_PHOTO_NAMES = ['alpha.arw', 'beta.arw', 'gamma.arw', 'delta.arw'];

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
  const names = new Map([
    [TRIAGE_PHOTOS_DIR, TRIAGE_PHOTO_NAMES],
    [STACK_PHOTOS_DIR, STACK_PHOTO_NAMES],
    [SELECT_PHOTOS_DIR, SELECT_PHOTO_NAMES],
    [URL_PHOTOS_DIR, URL_PHOTO_NAMES],
    // One frame, because a sync is a real decode and this library is only ever asked for
    // the bytes of a single photo.
    [DECODE_PHOTOS_DIR, DECODE_PHOTO_NAMES],
  ]);
  const namesFor = (dir: string): string[] => names.get(dir) ?? PHOTO_NAMES;
  for (const dir of [
    PHOTOS_DIR,
    STACK_PHOTOS_DIR,
    GRID_PHOTOS_DIR,
    SELECT_PHOTOS_DIR,
    FILTER_PHOTOS_DIR,
    BIN_PHOTOS_DIR,
    THUMBNAIL_PHOTOS_DIR,
    LAYOUT_PHOTOS_DIR,
    URL_PHOTOS_DIR,
    URL_OTHER_PHOTOS_DIR,
    INDEX_PHOTOS_DIR,
    SHELL_PHOTOS_DIR,
    VIEWER_PHOTOS_DIR,
    RENDITION_PHOTOS_DIR,
    HDR_PHOTOS_DIR,
    FRAME_PHOTOS_DIR,
    ZOOM_PHOTOS_DIR,
    PHONE_PHOTOS_DIR,
    TRIAGE_PHOTOS_DIR,
    EDIT_PHOTOS_DIR,
    MOBILE_EDIT_PHOTOS_DIR,
    PRINT_PHOTOS_DIR,
    ARCHIVE_PHOTOS_DIR,
    DECODE_PHOTOS_DIR,
    FALLBACK_PHOTOS_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
    for (const name of namesFor(dir)) copyFileSync(FIXTURE, path.join(dir, name));
  }
  // The X-Trans frame, which is a different sensor rather than a different subject: every root
  // above is the Bayer fixture under another name.
  mkdirSync(XTRANS_PHOTOS_DIR, { recursive: true });
  for (const name of XTRANS_PHOTO_NAMES) {
    copyFileSync(XTRANS_FIXTURE, path.join(XTRANS_PHOTOS_DIR, name));
  }
  // The panorama's views rather than copies of one frame: a composite needs overlap.
  //
  // **Rendered outside `E2E_ROOT`, which is wiped above, then copied in like every other
  // fixture.** They are a pure function of the crate, so `panoramaViews` renders them only where
  // they are not already there - and a directory this wipes is one where they never are, which
  // is a cargo build and six supersampled renders on every run of every spec.
  panoramaViews(PANORAMA_VIEWS);
  mkdirSync(PANORAMA_PHOTOS_DIR, { recursive: true });
  for (const name of PANORAMA_PHOTO_NAMES) {
    copyFileSync(path.join(PANORAMA_VIEWS, name), path.join(PANORAMA_PHOTOS_DIR, name));
  }
  mergeBurst(MERGE_BURST);
  mkdirSync(MERGE_PHOTOS_DIR, { recursive: true });
  for (const name of MERGE_PHOTO_NAMES) {
    copyFileSync(path.join(MERGE_BURST, name), path.join(MERGE_PHOTOS_DIR, name));
  }
}

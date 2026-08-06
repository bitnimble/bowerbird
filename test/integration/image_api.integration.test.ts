// Image API tests. image_api uses Bun.file, so these run under Bun (not host
// jest): docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../src/errors';
import { applyErrorHandler } from '../../src/api/error_handler';
import { ImageApi } from '../../src/api/image/image_api';
import type { Library } from '../../src/schemas/libraries';
import type { BasicPhoto } from '../../src/services/photos/photos_repository';
import type { PhotosService } from '../../src/services/photos/photos_service';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { DEFAULT_SETTINGS } from '../../src/schemas/settings';
import { dataPathForLibraryId } from '../../src/utils/paths';

// Only `get` is reached from these routes, and only by the editor's open.
const settingsForTest = () => ({ get: () => DEFAULT_SETTINGS }) as unknown as SettingsRepository;

// Serving bytes needs an id, a library and a file path and nothing else, so the
// API asks for `locate` rather than the detail payload (§8.2). Stubbing `get` here
// instead left every one of these tests failing with a 500.
function buildApp(root: string, photo: BasicPhoto | null, renditionHdr = false) {
  const library: Library = {
    // Per root, because the data directory is keyed by library id now (§3) and
    // these tests clean up after themselves.
    id: path.basename(root),
    root_path: root,
    bin_name: 'Bin',
    read_only: false,
    name: 'lib',
    ordering: 'taken_desc',
    rendition_source: 'render',
    rendition_hdr: renditionHdr,
    include_subfolders: true,
    mirror_shoots: true,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 1,
  };
  const photos = {
    locate(id: string): { photo: BasicPhoto; library: Library } {
      if (photo == null || photo.id !== id) throw new AppError('NOT_FOUND', `photo not found: ${id}`);
      return { photo, library };
    },
  } as unknown as PhotosService;
  const app = new Hono();
  app.route('/image', new ImageApi(photos, settingsForTest()).routes);
  applyErrorHandler(app);
  return app;
}

function photo(over: Partial<BasicPhoto>): BasicPhoto {
  return { id: 'p1', library_id: 'lib', file_path: 'a.arw', shoot_id: null, ...over };
}

// Where this root's library keeps its generated files, which is outside the root
// (§3): the tests write renditions the same way the server reads them.
function renditions(root: string, dir: string): string {
  return path.join(dataPathForLibraryId(path.basename(root)), 'renditions', dir);
}

function withRoot(run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-img-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataPathForLibraryId(path.basename(root)), { recursive: true, force: true });
    }
  };
}

test('serves a rendition with the avif content-type', withRoot(async (root) => {
  mkdirSync(renditions(root, 'grid'), { recursive: true });
  writeFileSync(path.join(renditions(root, 'grid'), 'p1.avif'), 'AVIFDATA');
  const res = await buildApp(root, photo({})).request('/image/p1/renditions/grid');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/avif');
  expect(await res.text()).toBe('AVIFDATA');
}));

// The grid tile is built SDR whatever the library asks for (§10.2), so reading it
// at the library's dynamic range looked for `renditions/grid-hdr/`, which nothing
// writes - and every tile in an HDR library 404'd.
test('serves the grid tile of an HDR library from the SDR directory', withRoot(async (root) => {
  mkdirSync(renditions(root, 'grid'), { recursive: true });
  writeFileSync(path.join(renditions(root, 'grid'), 'p1.avif'), 'AVIFDATA');
  const res = await buildApp(root, photo({}), true).request('/image/p1/renditions/grid');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('AVIFDATA');
}));

test('serves the original under its own format and filename', withRoot(async (root) => {
  writeFileSync(path.join(root, 'a.arw'), 'RAWBYTES');
  const res = await buildApp(root, photo({})).request('/image/p1/download/original');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/x-sony-arw');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="a.arw"');
}));

test('serves a Canon original under its own format and filename', withRoot(async (root) => {
  mkdirSync(path.join(root, 'Trip'), { recursive: true });
  writeFileSync(path.join(root, 'Trip', 'IMG_0116.CR3'), 'RAWBYTES');
  const res = await buildApp(root, photo({ file_path: 'Trip/IMG_0116.CR3' })).request('/image/p1/download/original');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/x-canon-cr3');
  // The name on disk, not the shoot-qualified path it is stored under.
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="IMG_0116.CR3"');
  expect(await res.text()).toBe('RAWBYTES');
}));

// JPEG cannot carry PQ, so transcoding an HDR rendition would hand back an SDR
// tone-map of the picture that was on screen and name it the same render.
test('downloads an HDR render as the AVIF the viewer showed', withRoot(async (root) => {
  mkdirSync(renditions(root, 'full-hdr'), { recursive: true });
  writeFileSync(path.join(renditions(root, 'full-hdr'), 'p1.avif'), 'AVIFDATA');
  const res = await buildApp(root, photo({}), true).request('/image/p1/download/full');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/avif');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="a-rendered.avif"');
  expect(await res.text()).toBe('AVIFDATA');
}));

test('downloads an HDR max render under its own name', withRoot(async (root) => {
  mkdirSync(renditions(root, 'max-hdr'), { recursive: true });
  writeFileSync(path.join(renditions(root, 'max-hdr'), 'p1.avif'), 'AVIFDATA');
  const res = await buildApp(root, photo({}), true).request('/image/p1/download/max');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="a-rendered-max.avif"');
}));

test('returns a 404 envelope for an unknown photo', withRoot(async (root) => {
  const res = await buildApp(root, null).request('/image/nope/renditions/grid');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}));

test('still serves a soft-deleted photo, so the Bin can be browsed', withRoot(async (root) => {
  mkdirSync(renditions(root, 'grid'), { recursive: true });
  writeFileSync(path.join(renditions(root, 'grid'), 'p1.avif'), 'AVIFDATA');
  // Deletion is not something this path can filter on even by accident: `locate`
  // returns a BasicPhoto, which carries no deletion flag, so the Bin's renditions
  // keep working by construction (§12.1).
  const res = await buildApp(root, photo({})).request('/image/p1/renditions/grid');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('AVIFDATA');
}));

test('returns a 404 envelope when the file is missing on disk', withRoot(async (root) => {
  const res = await buildApp(root, photo({})).request('/image/p1/renditions/full');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}));

// The editor's open answered 500 here, because `locate` reads the catalogue and the catalogue
// knows nothing about the disk - so a RAW that had been moved or unplugged reached LibRaw as
// a path that is not there, and the reason came back quoting the server's own absolute path.
// A library that is not mounted is not a server error, and where the server keeps its files
// is not the reader's business.
test('returns a 404 for an open whose RAW is gone, not a 500', withRoot(async (root) => {
  const res = await buildApp(root, photo({})).request('/image/p1/prepared?longEdge=0');
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('NOT_FOUND');
  expect(body.error.message).not.toContain(root);
}));

// `long_edge` crosses the FFI as a `u32`, and serde refuses one too big to fit - but only
// after the thread carrying it has been spawned, and as a 500 for something the reader got
// wrong. Refused here instead, before any of that.
test('refuses a longEdge no sensor could have', withRoot(async (root) => {
  const res = await buildApp(root, photo({})).request('/image/p1/prepared?longEdge=5000000000');
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
}));

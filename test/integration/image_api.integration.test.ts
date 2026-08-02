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

// Serving bytes needs an id, a library and a file path and nothing else, so the
// API asks for `locate` rather than the detail payload (§8.2). Stubbing `get` here
// instead left every one of these tests failing with a 500.
function buildApp(root: string, photo: BasicPhoto | null, renditionHdr = false) {
  const library: Library = {
    id: 'lib',
    root_path: root,
    data_path: null,
    bin_name: 'Bin',
    name: 'lib',
    ordering: 'taken_desc',
    rendition_source: 'render',
    rendition_hdr: renditionHdr,
    rendition_hdr_video: false,
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
  app.route('/image', new ImageApi(photos).routes);
  applyErrorHandler(app);
  return app;
}

function photo(over: Partial<BasicPhoto>): BasicPhoto {
  return { id: 'p1', library_id: 'lib', file_path: 'a.arw', shoot_id: null, ...over };
}

function withRoot(run: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-img-'));
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('serves a rendition with the avif content-type', withRoot(async (root) => {
  mkdirSync(path.join(root, '.bowerbird', 'renditions', 'grid'), { recursive: true });
  writeFileSync(path.join(root, '.bowerbird', 'renditions', 'grid', 'p1.avif'), 'AVIFDATA');
  const res = await buildApp(root, photo({})).request('/image/p1/renditions/grid');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/avif');
  expect(await res.text()).toBe('AVIFDATA');
}));

// The grid tile is built SDR whatever the library asks for (§10.2), so reading it
// at the library's dynamic range looked for `renditions/grid-hdr/`, which nothing
// writes - and every tile in an HDR library 404'd.
test('serves the grid tile of an HDR library from the SDR directory', withRoot(async (root) => {
  mkdirSync(path.join(root, '.bowerbird', 'renditions', 'grid'), { recursive: true });
  writeFileSync(path.join(root, '.bowerbird', 'renditions', 'grid', 'p1.avif'), 'AVIFDATA');
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

test('returns a 404 envelope for an unknown photo', withRoot(async (root) => {
  const res = await buildApp(root, null).request('/image/nope/renditions/grid');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}));

test('still serves a soft-deleted photo, so the Bin can be browsed', withRoot(async (root) => {
  mkdirSync(path.join(root, '.bowerbird', 'renditions', 'grid'), { recursive: true });
  writeFileSync(path.join(root, '.bowerbird', 'renditions', 'grid', 'p1.avif'), 'AVIFDATA');
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

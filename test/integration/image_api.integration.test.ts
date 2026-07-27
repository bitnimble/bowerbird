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
function buildApp(root: string, photo: BasicPhoto | null) {
  const library: Library = {
    id: 'lib',
    root_path: root,
    data_path: null,
    ordering: 'taken_desc',
    preview_source: 'render',
    preview_hdr: false,
    preview_hdr_video: false,
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

test('serves the original with the arw content-type', withRoot(async (root) => {
  writeFileSync(path.join(root, 'a.arw'), 'RAWBYTES');
  const res = await buildApp(root, photo({})).request('/image/p1/original.arw');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/x-sony-arw');
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
  // returns a BasicPhoto, which carries no deletion flag, so the Bin's thumbnails
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

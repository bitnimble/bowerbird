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
import type { PhotoDetail } from '../../src/schemas/photos';
import type { LibrariesService } from '../../src/services/libraries/libraries_service';
import type { PhotosService } from '../../src/services/photos/photos_service';

function buildApp(root: string, photo: PhotoDetail | null) {
  const photos = {
    get(id: string): PhotoDetail {
      if (photo == null || photo.id !== id) throw new AppError('NOT_FOUND', `photo not found: ${id}`);
      return photo;
    },
  } as unknown as PhotosService;
  const library: Library = { id: 'lib', root_path: root, data_path: null, ordering: 'taken_desc' };
  const libraries = { get: () => library } as unknown as LibrariesService;
  const app = new Hono();
  app.route('/image', new ImageApi(photos, libraries).routes);
  applyErrorHandler(app);
  return app;
}

function photo(over: Partial<PhotoDetail>): PhotoDetail {
  return { id: 'p1', library_id: 'lib', file_path: 'a.arw', is_deleted: false, ...over } as PhotoDetail;
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

test('serves a thumbnail with the webp content-type', withRoot(async (root) => {
  mkdirSync(path.join(root, '.bowerbird', 'thumbnails', 'small'), { recursive: true });
  writeFileSync(path.join(root, '.bowerbird', 'thumbnails', 'small', 'p1.webp'), 'WEBPDATA');
  const res = await buildApp(root, photo({})).request('/image/p1/small.webp');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/webp');
  expect(await res.text()).toBe('WEBPDATA');
}));

test('serves the original with the arw content-type', withRoot(async (root) => {
  writeFileSync(path.join(root, 'a.arw'), 'RAWBYTES');
  const res = await buildApp(root, photo({})).request('/image/p1/original.arw');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/x-sony-arw');
}));

test('returns a 404 envelope for an unknown photo', withRoot(async (root) => {
  const res = await buildApp(root, null).request('/image/nope/small.webp');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}));

test('returns a 404 envelope for a deleted photo', withRoot(async (root) => {
  const res = await buildApp(root, photo({ is_deleted: true })).request('/image/p1/small.webp');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}));

test('returns a 404 envelope when the file is missing on disk', withRoot(async (root) => {
  const res = await buildApp(root, photo({})).request('/image/p1/full.webp');
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
}));

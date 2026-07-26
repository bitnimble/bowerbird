import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { PhotoListResponse } from '../../../schemas/photos';
import type { PhotosService } from '../../../services/photos/photos_service';
import type { ProcessingService } from '../../../services/processing/processing_service';
import { PhotosApi } from '../photos_api';

const emptyList: PhotoListResponse = { photos: [], total: 0, offset: 0, limit: 100 };

function buildApp(over: Partial<PhotosService> = {}) {
  const service = {
    get: jest.fn(),
    listByLibrary: jest.fn(() => emptyList),
    listMissing: jest.fn(() => emptyList),
    listByShoot: jest.fn(() => emptyList),
    listByAlbum: jest.fn(() => emptyList),
    update: jest.fn(),
    delete: jest.fn(async () => {}),
    ...over,
  } as unknown as PhotosService;
  const processing = { reprocess: jest.fn(async () => 0) } as unknown as ProcessingService;
  const app = new Hono();
  app.route('/api', new PhotosApi(service, processing).routes);
  applyErrorHandler(app);
  return { app, service };
}

const PID = '11111111-1111-4111-8111-111111111111';

describe('PhotosApi', () => {
  it('lists library photos (200)', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/libraries/lib/photos');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptyList);
  });

  it('maps a service NOT_FOUND to the 404 envelope', async () => {
    const { app } = buildApp({
      get: jest.fn(() => {
        throw new AppError('NOT_FOUND', 'photo not found: x');
      }),
    });
    const res = await app.request('/api/photos/x');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'photo not found: x' } });
  });

  it('rejects an out-of-range rating with a 400 validation envelope', async () => {
    const { app, service } = buildApp();
    const res = await app.request('/api/photos/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 9 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('rejects an empty photo_ids delete', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/photos/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('deletes photos and returns 204', async () => {
    const del = jest.fn(async () => {});
    const { app } = buildApp({ delete: del });
    const res = await app.request('/api/photos/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID] }),
    });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith([PID]);
  });

  it('returns the JSON envelope for an unmatched route', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/nope/route');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('parses stringbool + numeric query filters', async () => {
    const listByLibrary = jest.fn(() => emptyList);
    const { app } = buildApp({ listByLibrary });
    await app.request('/api/libraries/lib/photos?is_missing=false&include_deleted=true&limit=50');
    expect(listByLibrary).toHaveBeenCalledWith(
      'lib',
      expect.objectContaining({ is_missing: false, include_deleted: true, limit: 50 }),
    );
  });
});

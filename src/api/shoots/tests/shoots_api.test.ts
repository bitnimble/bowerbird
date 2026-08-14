import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { PhotoListResponse } from '../../../schemas/photos';
import type { Shoot } from '../../../schemas/shoots';
import type { PhotosService } from '../../../services/photos/photos_service';
import type { ShootsService } from '../../../services/shoots/shoots_service';
import { ShootsApi } from '../shoots_api';

const LIB = 'lib00001';
const PID = 'photo001';
const shoot: Shoot = { id: 's1', parent_id: null, library_id: LIB, folder_path: 'Trip', name: 'Trip', description: null, banner_photo_id: null, ordering: 'taken_desc', photo_count: 0 };
const emptyList: PhotoListResponse = { photos: [], total: 0, offset: 0, limit: 100, ordering: 'taken_asc' };

function buildApp(shoots: Partial<ShootsService> = {}, photos: Partial<PhotosService> = {}) {
  const shootsSvc = {
    create: jest.fn(async () => shoot),
    get: jest.fn(() => shoot),
    list: jest.fn(() => [shoot]),
    update: jest.fn(async () => shoot),
    delete: jest.fn(),
    addPhotos: jest.fn(async () => {}),
    removePhotos: jest.fn(async () => {}),
    ...shoots,
  } as unknown as ShootsService;
  const photosSvc = {
    listByShoot: jest.fn(() => emptyList),
    // Bulk routes take ids or the positions to read them from (§18.3.3).
    resolve: jest.fn((target: { photo_ids?: string[] }) => target.photo_ids ?? []),
    ...photos,
  } as unknown as PhotosService;
  const app = new Hono();
  app.route('/api', new ShootsApi(shootsSvc, photosSvc).routes);
  applyErrorHandler(app);
  return { app, shoots: shootsSvc, photos: photosSvc };
}

describe('ShootsApi', () => {
  it('creates a shoot (201)', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/shoots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_id: LIB, name: 'Trip' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects a path-traversal name at the schema (400)', async () => {
    const create = jest.fn(async () => shoot);
    const { app } = buildApp({ create });
    const res = await app.request('/api/shoots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_id: LIB, name: '../escape' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('lists shoots for a library', async () => {
    const list = jest.fn(() => [shoot]);
    const { app } = buildApp({ list });
    const res = await app.request(`/api/libraries/${LIB}/shoots`);
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(LIB);
  });

  it('adds photos to a shoot (204)', async () => {
    const addPhotos = jest.fn(async () => {});
    const { app } = buildApp({ addPhotos });
    const res = await app.request('/api/shoots/s1/photos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID] }),
    });
    expect(res.status).toBe(204);
    expect(addPhotos).toHaveBeenCalledWith('s1', [PID]);
  });

  it('maps NOT_FOUND from get', async () => {
    const { app } = buildApp({ get: jest.fn(() => { throw new AppError('NOT_FOUND', 'x'); }) });
    const res = await app.request('/api/shoots/x');
    expect(res.status).toBe(404);
  });
});

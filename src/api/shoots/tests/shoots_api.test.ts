import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { PhotoListResponse } from '../../../schemas/photos';
import { PathSegment, route } from '../../../schemas/route';
import type { Shoot } from '../../../schemas/shoots';
import type { PhotoReadService } from '../../../services/photos/listing/photo_read_service';
import type { ShootsService } from '../../../services/shoots/shoots_service';
import { ShootsApi } from '../shoots_api';

const LIB = 'lib00001';
const PID = 'photo001';
const shoot: Shoot = { id: 'shoot001', parent_id: null, library_id: LIB, folder_path: 'Trip', name: 'Trip', description: null, banner_photo_id: null, ordering: 'taken_desc', photo_count: 0, is_hidden: false, hidden_directly: false };
const emptyList: PhotoListResponse = { photos: [], total: 0, offset: 0, limit: 100, ordering: 'taken_asc' };

function buildApp(shoots: Partial<ShootsService> = {}, photos: Partial<PhotoReadService> = {}) {
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
  } as unknown as PhotoReadService;
  const app = new Hono();
  app.route(route(PathSegment.api()), new ShootsApi(shootsSvc, photosSvc).routes);
  applyErrorHandler(app);
  return { app, shoots: shootsSvc, photos: photosSvc };
}

describe('ShootsApi', () => {
  it('creates a shoot (201)', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.shoots()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_id: LIB, name: 'Trip' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects a path-traversal name at the schema (400)', async () => {
    const create = jest.fn(async () => shoot);
    const { app } = buildApp({ create });
    const res = await app.request(route(PathSegment.api(), PathSegment.shoots()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_id: LIB, name: '../escape' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(create).not.toHaveBeenCalled();
  });

  // The shoots put away are left out unless the request asks, so a consumer that has not thought
  // about hiding cannot be handed one (§12.4).
  it('lists shoots for a library, without the hidden ones unless asked', async () => {
    const list = jest.fn(() => [shoot]);
    const { app } = buildApp({ list });

    expect(
      (await app.request(route(PathSegment.api(), PathSegment.libraries(), LIB, PathSegment.shoots()))).status,
    ).toBe(200);
    expect(list).toHaveBeenCalledWith(LIB, false);

    await app.request(`${route(PathSegment.api(), PathSegment.libraries(), LIB, PathSegment.shoots())}?include_hidden=true`);
    expect(list).toHaveBeenLastCalledWith(LIB, true);
  });

  it('adds photos to a shoot (204)', async () => {
    const addPhotos = jest.fn(async () => {});
    const { app } = buildApp({ addPhotos });
    const res = await app.request(route(PathSegment.api(), PathSegment.shoots(), 's1', PathSegment.photos()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID] }),
    });
    expect(res.status).toBe(204);
    expect(addPhotos).toHaveBeenCalledWith('s1', [PID]);
  });

  it('maps NOT_FOUND from get', async () => {
    const { app } = buildApp({ get: jest.fn(() => { throw new AppError('NOT_FOUND', 'x'); }) });
    const res = await app.request(route(PathSegment.api(), PathSegment.shoots(), 'x'));
    expect(res.status).toBe(404);
  });
});

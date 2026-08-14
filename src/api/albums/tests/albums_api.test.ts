import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { Album } from '../../../schemas/albums';
import type { PhotoListResponse } from '../../../schemas/photos';
import type { AlbumsService } from '../../../services/albums/albums_service';
import type { PhotosService } from '../../../services/photos/photos_service';
import { AlbumsApi } from '../albums_api';

const PID = 'photo001';
const album: Album = { id: 'a1', name: 'Faves', ordering: 'taken_desc', banner_photo_id: null, photo_count: 0 };
const emptyList: PhotoListResponse = { photos: [], total: 0, offset: 0, limit: 100, ordering: 'taken_asc' };

function buildApp(albums: Partial<AlbumsService> = {}, photos: Partial<PhotosService> = {}) {
  const albumsSvc = {
    create: jest.fn(() => album),
    get: jest.fn(() => album),
    list: jest.fn(() => [album]),
    update: jest.fn(() => album),
    delete: jest.fn(),
    addPhotos: jest.fn(),
    removePhotos: jest.fn(),
    ...albums,
  } as unknown as AlbumsService;
  const photosSvc = {
    listByAlbum: jest.fn(() => emptyList),
    // Bulk routes take ids or the positions to read them from (§18.3.3).
    resolve: jest.fn((target: { photo_ids?: string[] }) => target.photo_ids ?? []),
    ...photos,
  } as unknown as PhotosService;
  const app = new Hono();
  app.route('/api/albums', new AlbumsApi(albumsSvc, photosSvc).routes);
  applyErrorHandler(app);
  return { app, albums: albumsSvc, photos: photosSvc };
}

describe('AlbumsApi', () => {
  it('creates an album (201)', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Faves' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects an empty name (400)', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/albums', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('lists albums', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/albums');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([album]);
  });

  it('adds photos (204) and lists album photos', async () => {
    const addPhotos = jest.fn();
    const listByAlbum = jest.fn(() => emptyList);
    const { app } = buildApp({ addPhotos }, { listByAlbum });
    const add = await app.request('/api/albums/a1/photos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID] }),
    });
    expect(add.status).toBe(204);
    expect(addPhotos).toHaveBeenCalledWith('a1', [PID]);
    const list = await app.request('/api/albums/a1/photos');
    expect(list.status).toBe(200);
    expect(listByAlbum).toHaveBeenCalled();
  });

  it('maps NOT_FOUND from get', async () => {
    const { app } = buildApp({ get: jest.fn(() => { throw new AppError('NOT_FOUND', 'x'); }) });
    const res = await app.request('/api/albums/x');
    expect(res.status).toBe(404);
  });
});

import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { PhotoListResponse } from '../../../schemas/photos';
import type { PhotosService } from '../../../services/photos/photos_service';
import type { ProcessingService } from '../../../services/processing/processing_service';
import { PhotosApi } from '../photos_api';

const emptyList: PhotoListResponse = { photos: [], total: 0, offset: 0, limit: 100, ordering: 'taken_asc' };

function buildApp(over: Partial<PhotosService> = {}) {
  const service = {
    get: jest.fn(),
    listByLibrary: jest.fn(() => emptyList),
    listMissing: jest.fn(() => emptyList),
    listByShoot: jest.fn(() => emptyList),
    listByAlbum: jest.fn(() => emptyList),
    update: jest.fn(),
    delete: jest.fn(async () => {}),
    // The real one reads a selection's ids off the same listing the grid was
    // built from; here every route just needs the ids it was handed back.
    resolve: jest.fn((target: { photo_ids?: string[] }) => target.photo_ids ?? [PID]),
    ...over,
  } as unknown as PhotosService;
  const processing = { rebuildTiles: jest.fn(async () => 1) } as unknown as ProcessingService;
  const app = new Hono();
  app.route('/api', new PhotosApi(service, processing).routes);
  applyErrorHandler(app);
  return { app, service, processing };
}

const PID = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';

const selectionStatus = async (app: Hono, ranges: { start: number; end: number }[]): Promise<number> => {
  const res = await app.request('/api/photos/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selection: { scope: { kind: 'library', id: PID }, ranges } }),
  });
  return res.status;
};

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

  // Answers with a count, not with the ids: the undo names the batch the client
  // stamped the request with, so a bin of a million is not a 36MB response
  // (§12.3).
  it('deletes photos, stamps the batch, and answers with a count', async () => {
    const del = jest.fn(async () => {});
    const { app } = buildApp({ delete: del });
    const res = await app.request('/api/photos/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID], batch: BATCH }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(del).toHaveBeenCalledWith([PID], BATCH);
  });

  // And the undo names that batch rather than carrying the ids back.
  it('restores everything one batch took', async () => {
    const restore = jest.fn(async () => {});
    const { app, service } = buildApp({ restore });
    const res = await app.request('/api/photos/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: BATCH }),
    });
    expect(res.status).toBe(204);
    expect(service.resolve).toHaveBeenCalledWith({ batch: BATCH });
  });

  // A client holding a window of a huge collection names its photos by where
  // they sit rather than by id (§18.3.3); the route resolves them first.
  it('deletes a selection named by position', async () => {
    const del = jest.fn(async () => {});
    const { app, service } = buildApp({ delete: del });
    const selection = {
      scope: { kind: 'library', id: PID },
      filters: { triage: ['picked'] },
      ranges: [{ start: 0, end: 99_999 }],
    };
    const res = await app.request('/api/photos/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection }),
    });
    expect(res.status).toBe(200);
    expect(service.resolve).toHaveBeenCalledWith({ selection: { ...selection, filters: { triage: ['picked'] }, members: [] } });
    expect(del).toHaveBeenCalledWith([PID], undefined);
  });

  // A selection can be nothing but photos picked out of an open stack, which have
  // no position to be in a run at all (§19.6.1).
  it('deletes a selection named by member id alone', async () => {
    const del = jest.fn(async () => {});
    const { app, service } = buildApp({ delete: del });
    const selection = { scope: { kind: 'library', id: PID }, ranges: [], members: [PID] };
    const res = await app.request('/api/photos/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection }),
    });
    expect(res.status).toBe(200);
    expect(service.resolve).toHaveBeenCalledWith({ selection: { ...selection, filters: {} } });
  });

  it('rejects a selection that names neither a range nor a member', async () => {
    const { app } = buildApp();
    expect(await selectionStatus(app, [])).toBe(400);
  });

  it('rejects a selection whose range ends before it starts', async () => {
    const { app } = buildApp();
    expect(await selectionStatus(app, [{ start: 5, end: 4 }])).toBe(400);
  });

  // Overlapping runs would name the same photo more than once, so ten thousand
  // copies of one whole-library run would resolve to ten thousand times its ids.
  it('rejects runs that overlap or run backwards', async () => {
    const { app } = buildApp();
    expect(
      await selectionStatus(app, [
        { start: 0, end: 10 },
        { start: 5, end: 20 },
      ]),
    ).toBe(400);
    expect(
      await selectionStatus(app, [
        { start: 30, end: 40 },
        { start: 0, end: 10 },
      ]),
    ).toBe(400);
    expect(
      await selectionStatus(app, [
        { start: 0, end: 10 },
        { start: 11, end: 20 },
      ]),
    ).toBe(200);
  });

  it('queues a tile rebuild for the ids it was given', async () => {
    const { app, processing } = buildApp();
    const res = await app.request('/api/photos/rebuild-tiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 1 });
    expect(processing.rebuildTiles).toHaveBeenCalledWith([PID]);
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

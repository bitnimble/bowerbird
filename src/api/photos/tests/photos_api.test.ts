import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { PhotoListResponse } from '../../../schemas/photos';
import { PathSegment, route } from '../../../schemas/route';
import type { PhotoReadService } from '../../../services/photos/listing/photo_read_service';
import type { PhotoMutationService } from '../../../services/photos/mutations/photo_mutation_service';
import type { PhotoRenditionService } from '../../../services/photos/renditions/photo_rendition_service';
import type { ProcessingService } from '../../../services/processing/pipeline/processing_service';
import { PhotosApi } from '../photos_api';

const emptyList: PhotoListResponse = { photos: [], total: 0, offset: 0, limit: 100, ordering: 'taken_asc' };

function buildApp(over: {
  read?: Partial<PhotoReadService>;
  mutations?: Partial<PhotoMutationService>;
  renditions?: Partial<PhotoRenditionService>;
} = {}) {
  const read = {
    get: jest.fn(),
    listByLibrary: jest.fn(() => emptyList),
    listMissing: jest.fn(() => emptyList),
    listByShoot: jest.fn(() => emptyList),
    listByAlbum: jest.fn(() => emptyList),
    // The real one reads a selection's ids off the same listing the grid was
    // built from; here every route just needs the ids it was handed back.
    resolve: jest.fn((target: { photo_ids?: string[] }) => target.photo_ids ?? [PID]),
    ...over.read,
  } as unknown as PhotoReadService;
  const mutations = {
    update: jest.fn(),
    delete: jest.fn(async () => {}),
    restore: jest.fn(async () => {}),
    mark: jest.fn(() => 0),
    hide: jest.fn(() => 0),
    ...over.mutations,
  } as unknown as PhotoMutationService;
  const renditions = {
    refreshMetadata: jest.fn(async () => 0),
    buildRendition: jest.fn(async () => {}),
    renditionJob: jest.fn(() => null),
    ...over.renditions,
  } as unknown as PhotoRenditionService;
  const processing = { rebuildTiles: jest.fn(async () => 1) } as unknown as ProcessingService;
  const app = new Hono();
  app.route(route(PathSegment.api()), new PhotosApi(read, mutations, renditions, processing).routes);
  applyErrorHandler(app);
  return { app, read, mutations, renditions, processing };
}

const PID = 'photo001';
const BATCH = 'batch001';

const selectionStatus = async (app: Hono, ranges: { start: number; end: number }[]): Promise<number> => {
  const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: { selection: { scope: { kind: 'library', id: PID }, ranges } } }),
  });
  return res.status;
};

describe('PhotosApi', () => {
  it('lists library photos (200)', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), 'lib', PathSegment.photos()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptyList);
  });

  // The one bulk route that answers with the ids rather than a count, because the export
  // renders one file per photograph on the client and needs the list to loop over (§10.5.1).
  it('answers a selection with the photographs it stands for', async () => {
    const { app, read } = buildApp({ read: { resolve: jest.fn(() => ['photo001', 'photo002', 'photo003']) } });
    const selection = { scope: { kind: 'library', id: PID }, ranges: [{ start: 0, end: 2 }] };
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.ids()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ photo_ids: ['photo001', 'photo002', 'photo003'] });
    // Resolved against the same shape every other bulk route resolves, not a second reading.
    expect(read.resolve).toHaveBeenCalledWith({ selection: { ...selection, filters: {}, members: [] } });
  });

  it('refuses a target that names nothing', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.ids()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: { scope: { kind: 'library', id: PID }, ranges: [] } }),
    });
    expect(res.status).toBe(400);
  });

  it('maps a service NOT_FOUND to the 404 envelope', async () => {
    const { app } = buildApp({
      read: { get: jest.fn(() => {
        throw new AppError('NOT_FOUND', 'photo not found: x');
      }) },
    });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), 'x'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'photo not found: x' } });
  });

  it('rejects an out-of-range rating with a 400 validation envelope', async () => {
    const { app, mutations } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), 'x'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 9 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(mutations.update).not.toHaveBeenCalled();
  });

  it('rejects an empty photo_ids delete', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { photo_ids: [] } }),
    });
    expect(res.status).toBe(400);
  });

  // Answers with a count, not with the ids: the undo names the batch the client
  // stamped the request with, so a bin of a million is not a 36MB response
  // (§12.3).
  it('deletes photos, stamps the batch, and answers with a count', async () => {
    const del = jest.fn(async () => {});
    const { app } = buildApp({ mutations: { delete: del } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { photo_ids: [PID] }, batch: BATCH }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(del).toHaveBeenCalledWith([PID], BATCH);
  });

  it('bins what a past bin took under a batch of its own', async () => {
    const del = jest.fn(async () => {});
    const { app, read } = buildApp({ mutations: { delete: del } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { batch: 'batch000' }, batch: BATCH }),
    });
    expect(res.status).toBe(200);
    expect(read.resolve).toHaveBeenCalledWith({ batch: 'batch000' });
    expect(del).toHaveBeenCalledWith([PID], BATCH);
  });

  // And the undo names that batch rather than carrying the ids back.
  it('restores everything one batch took', async () => {
    const restore = jest.fn(async () => {});
    const { app, read } = buildApp({ mutations: { restore } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.restore()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batch: BATCH }),
    });
    expect(res.status).toBe(204);
    expect(read.resolve).toHaveBeenCalledWith({ batch: BATCH });
  });

  // A client holding a window of a huge collection names its photos by where
  // they sit rather than by id (§18.3.3); the route resolves them first.
  it('deletes a selection named by position', async () => {
    const del = jest.fn(async () => {});
    const { app, read } = buildApp({ mutations: { delete: del } });
    const selection = {
      scope: { kind: 'library', id: PID },
      filters: { triage: ['picked'] },
      ranges: [{ start: 0, end: 99_999 }],
    };
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { selection } }),
    });
    expect(res.status).toBe(200);
    expect(read.resolve).toHaveBeenCalledWith({ selection: { ...selection, filters: { triage: ['picked'] }, members: [] } });
    expect(del).toHaveBeenCalledWith([PID], undefined);
  });

  // A selection can be nothing but photos picked out of an open stack, which have
  // no position to be in a run at all (§19.6.1).
  it('deletes a selection named by member id alone', async () => {
    const del = jest.fn(async () => {});
    const { app, read } = buildApp({ mutations: { delete: del } });
    const selection = { scope: { kind: 'library', id: PID }, ranges: [], members: [PID] };
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { selection } }),
    });
    expect(res.status).toBe(200);
    expect(read.resolve).toHaveBeenCalledWith({ selection: { ...selection, filters: {} } });
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
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.rebuildTiles()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: [PID] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 1 });
    expect(processing.rebuildTiles).toHaveBeenCalledWith([PID]);
  });

  it('marks the resolved selection with the verdict it was given', async () => {
    const mark = jest.fn(() => 3);
    const { app, mutations } = buildApp({ mutations: { mark } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.mark()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { photo_ids: [PID] }, triage: 'picked' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 3 });
    expect(mutations.mark).toHaveBeenCalledWith([PID], { triage: 'picked' });
  });

  // The two fields a cull sets, and no others: a note or a rendition choice is
  // about one photograph, and one arriving here would be set on every one.
  it('drops fields a mark is not about', async () => {
    const mark = jest.fn(() => 1);
    const { app, mutations } = buildApp({ mutations: { mark } });
    await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.mark()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { photo_ids: [PID] }, rating: 4, notes: 'nope', viewer_rendition: 'full' }),
    });
    expect(mutations.mark).toHaveBeenCalledWith([PID], { rating: 4 });
  });

  it('rejects an out-of-range rating on a mark', async () => {
    const mark = jest.fn(() => 0);
    const { app, mutations } = buildApp({ mutations: { mark } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.mark()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: { photo_ids: [PID] }, rating: 9 }),
    });
    expect(res.status).toBe(400);
    expect(mutations.mark).not.toHaveBeenCalled();
  });

  it('returns the JSON envelope for an unmatched route', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), 'nope', 'route'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('hands the models route its scope and the filters of the view asking', async () => {
    const modelsOf = jest.fn(() => ({ pairs: [] }));
    const { app } = buildApp({ read: { modelsOf } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.models()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'album', id: PID }, filters: { include_deleted: true, is_deleted: true } }),
    });

    expect(res.status).toBe(200);
    expect(modelsOf).toHaveBeenCalledWith({
      scope: { kind: 'album', id: PID },
      filters: { include_deleted: true, is_deleted: true },
    });
  });

  it('takes a models request that states no filters as the whole of the collection', async () => {
    const modelsOf = jest.fn(() => ({ pairs: [] }));
    const { app } = buildApp({ read: { modelsOf } });
    await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.models()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'library', id: PID } }),
    });

    expect(modelsOf).toHaveBeenCalledWith({ scope: { kind: 'library', id: PID }, filters: {} });
  });

  it('hands the days route its scope and the filters of the view asking', async () => {
    const daysOf = jest.fn(() => ({ days: [{ day: '2024-03-09', count: 2 }] }));
    const { app } = buildApp({ read: { daysOf } });
    const res = await app.request(route(PathSegment.api(), PathSegment.photos(), PathSegment.days()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'shoot', id: PID }, filters: { is_missing: true } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: [{ day: '2024-03-09', count: 2 }] });
    expect(daysOf).toHaveBeenCalledWith({ scope: { kind: 'shoot', id: PID }, filters: { is_missing: true } });
  });

  it('parses a comma-separated body and lens list, and drops the empty entries of one', async () => {
    const listByLibrary = jest.fn(() => emptyList);
    const { app } = buildApp({ read: { listByLibrary } });
    await app.request(
      `${route(PathSegment.api(), PathSegment.libraries(), 'lib', PathSegment.photos())}?camera_models=ILCE-7RM5,Canon%20EOS%20R5&lens_models=FE%2085mm%20F1.4%20GM,`,
    );
    expect(listByLibrary).toHaveBeenCalledWith(
      'lib',
      expect.objectContaining({ camera_models: ['ILCE-7RM5', 'Canon EOS R5'], lens_models: ['FE 85mm F1.4 GM'] }),
    );
  });

  it('parses stringbool + numeric query filters', async () => {
    const listByLibrary = jest.fn(() => emptyList);
    const { app } = buildApp({ read: { listByLibrary } });
    await app.request(
      `${route(PathSegment.api(), PathSegment.libraries(), 'lib', PathSegment.photos())}?is_missing=false&include_deleted=true&limit=50`,
    );
    expect(listByLibrary).toHaveBeenCalledWith(
      'lib',
      expect.objectContaining({ is_missing: false, include_deleted: true, limit: 50 }),
    );
  });
});

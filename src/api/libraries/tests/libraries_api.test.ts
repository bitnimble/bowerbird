import { describe, it, expect, jest } from 'bun:test';
import { AppError } from '../../../errors';
import { PathSegment, route } from '../../../schemas/route';
import { ActivitySnapshotSchema, type ActivitySnapshot } from '../../../schemas/activity';
import { LibraryActivity } from '../../../services/activity/library_activity';
import { LIBRARY_ID, buildApp, library, status } from './libraries_api_test_helpers';

describe('LibrariesApi', () => {
  it('reports independent queues and global work in one live library snapshot', async () => {
    const activity = new LibraryActivity();
    const finishFetch = activity.begin(LIBRARY_ID, 'fetching', 'photo');
    const finishBackup = activity.begin(null, 'catalogue_backup');
    const list = jest.fn(() => [{ ...library, photo_count: 10, missing_photo_count: 2, rendered_photo_count: 5 }]);
    const { app } = buildApp(
      { list },
      { getScanStatus: () => ({ ...status, status: 'idle', photos_processing: 3 }) },
      {}, undefined, {},
      (id) => activity.current(id),
      () => activity.current(null),
    );
    const read = async (): Promise<ActivitySnapshot> => {
      const response = await app.request(route(PathSegment.api(), PathSegment.libraries(), PathSegment.activity()));
      expect(response.status).toBe(200);
      return ActivitySnapshotSchema.parse(await response.json());
    };

    const fetching = await read();
    expect(list).toHaveBeenCalledTimes(1);
    expect(fetching.libraries[0]).toMatchObject({
      photo_count: 10, missing_photo_count: 2, rendered_photo_count: 5,
      activities: [{ kind: 'fetching', count: 1 }],
      scan: { status: 'idle', photos_processing: 3 },
    });
    expect(fetching.global).toEqual([{ kind: 'catalogue_backup', count: 1 }]);

    finishFetch();
    const rendering = await read();
    expect(rendering.libraries[0]?.activities).toEqual([]);
    expect(rendering.libraries[0]?.scan.photos_processing).toBe(3);

    list.mockReturnValue([]);
    expect(await read()).toEqual({ libraries: [], global: [{ kind: 'catalogue_backup', count: 1 }] });
    finishBackup();
    expect(await read()).toEqual({ libraries: [], global: [] });
  });

  it('creates a library (201)', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '/r' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects an empty root_path (400 envelope)', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('maps a CONFLICT from the service', async () => {
    const { app } = buildApp({ create: jest.fn(() => { throw new AppError('CONFLICT', 'dup'); }) });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '/r' }),
    });
    expect(res.status).toBe(409);
  });

  it('triggers a scan and returns its status', async () => {
    const scanLibrary = jest.fn(async () => status);
    const { app } = buildApp({}, { scanLibrary });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.sync()), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(scanLibrary).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('queues a library-wide tile rebuild', async () => {
    const rebuildTiles = jest.fn(() => status);
    const { app } = buildApp({}, { rebuildTiles });
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.tiles()),
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(rebuildTiles).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('queues a library-wide rendition rebuild', async () => {
    const rebuildRenditions = jest.fn(() => status);
    const { app } = buildApp({}, { rebuildRenditions });
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.renditions()),
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(rebuildRenditions).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('re-forms the automatic stacks and answers with how many there are', async () => {
    const detectStacks = jest.fn(() => 4);
    const { app } = buildApp({}, {}, {}, detectStacks);
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.stacks()),
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stacks: 4 });
    expect(detectStacks).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('refuses stack detection for a library that does not exist', async () => {
    const detectStacks = jest.fn(() => 0);
    const { app } = buildApp(
      { get: jest.fn(() => { throw new AppError('NOT_FOUND', 'no such library'); }) },
      {},
      {},
      detectStacks,
    );
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), 'nope', PathSegment.jobs(), PathSegment.stacks()),
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
    expect(detectStacks).not.toHaveBeenCalled();
  });

  it('maps VALIDATION_ERROR when a library has no renders to rebuild', async () => {
    const { app } = buildApp(
      {},
      { rebuildRenditions: jest.fn(() => { throw new AppError('VALIDATION_ERROR', 'no renders'); }) },
    );
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.renditions()),
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 409 when a rebuild is asked for while a scan is running', async () => {
    const { app } = buildApp(
      {},
      { rebuildTiles: jest.fn(() => { throw new AppError('SYNC_IN_PROGRESS', 'busy'); }) },
    );
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.tiles()),
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
  });

  it('returns 409 when a scan is already running', async () => {
    const { app } = buildApp({}, { scanLibrary: jest.fn(() => { throw new AppError('SYNC_IN_PROGRESS', 'busy'); }) });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.sync()), { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('deletes a library (204)', async () => {
    const del = jest.fn();
    const { app } = buildApp({ delete: del });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID), { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith(LIBRARY_ID);
  });
});

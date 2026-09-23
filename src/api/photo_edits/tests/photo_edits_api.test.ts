import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import { neutralEdits, type EditState } from '../../../schemas/photo_edits';
import { PathSegment, route } from '../../../schemas/route';
import type { PhotoEditsService } from '../../../services/photo_edits/photo_edits_service';
import { PhotoEditsApi } from '../photo_edits_api';

const state: EditState = { doc: neutralEdits(), rev: 1, canUndo: true, canRedo: false };

function buildApp(over: Partial<PhotoEditsService> = {}) {
  const service = {
    get: jest.fn(() => state),
    save: jest.fn(() => state),
    undo: jest.fn(() => state),
    redo: jest.fn(() => state),
    restore: jest.fn(() => state),
    finish: jest.fn(),
    ...over,
  } as unknown as PhotoEditsService;
  const app = new Hono();
  app.route(route(PathSegment.api()), new PhotoEditsApi(service).routes);
  applyErrorHandler(app);
  return { app, service };
}

async function send(app: Hono, method: 'POST' | 'PUT', path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const post = (app: Hono, path: string, body: unknown) => send(app, 'POST', path, body);
const put = (app: Hono, path: string, body: unknown) => send(app, 'PUT', path, body);

describe('PhotoEditsApi', () => {
  it('answers a read with the document and the revision the next write must carry', async () => {
    const { app, service } = buildApp();

    const response = await app.request(route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(service.get).toHaveBeenCalledWith('p1');
  });

  it('answers a checkpoint with the undo history and the stamp behind the document', async () => {
    const checkpoint = { ...state, cursor: 1, history: [{ from: { exposure: 0 }, to: { exposure: 1 } }], stamp: 'stamp' };
    const { app, service } = buildApp({ checkpoint: jest.fn(() => checkpoint) });

    const response = await app.request(
      route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits(), PathSegment.checkpoint()),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(checkpoint);
    expect(service.checkpoint).toHaveBeenCalledWith('p1');
  });

  it('passes the whole document and its revision through to the service', async () => {
    const { app, service } = buildApp();
    const doc = { ...neutralEdits(), exposure: 1.25 };

    const response = await app.request(route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits()), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc, rev: 3, session: 'session1' }),
    });

    expect(response.status).toBe(200);
    expect(service.save).toHaveBeenCalledWith('p1', expect.objectContaining({ exposure: 1.25 }), 3, 'session1');
  });

  it('refuses a save that states no revision', async () => {
    const { app, service } = buildApp();

    const response = await put(app, route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits()), { doc: neutralEdits() });

    // Optional would defeat the point: a client that omits it is exactly the one
    // that would overwrite another tab's edit.
    expect(response.status).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('refuses a document whose values are out of range', async () => {
    const { app, service } = buildApp();

    const response = await app.request(route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits()), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: { ...neutralEdits(), exposure: 99 }, rev: 0 }),
    });

    expect(response.status).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('steps back and forward, each carrying the revision it was read at', async () => {
    const { app, service } = buildApp();

    expect(
      (await post(app, route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits(), PathSegment.undo()), { rev: 2 })).status,
    ).toBe(200);
    expect(
      (await post(app, route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits(), PathSegment.redo()), { rev: 2 })).status,
    ).toBe(200);

    expect(service.undo).toHaveBeenCalledWith('p1', 2);
    expect(service.redo).toHaveBeenCalledWith('p1', 2);
  });

  it('restores a checkpoint, and refuses one whose cursor is past its history', async () => {
    const { app, service } = buildApp();
    const path = route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits(), PathSegment.restore());
    const history = [{ from: { exposure: 0 }, to: { exposure: 1 } }];

    const past = await post(app, path, { rev: 2, session: 'session1', doc: neutralEdits(), cursor: 2, history });
    expect(past.status).toBe(400);
    expect(service.restore).not.toHaveBeenCalled();

    const response = await post(app, path, { rev: 2, session: 'session1', doc: neutralEdits(), cursor: 1, history });
    expect(response.status).toBe(200);
    expect(service.restore).toHaveBeenCalledWith('p1', 2, { doc: neutralEdits(), cursor: 1, history }, 'session1');
  });

  it('takes the editor closing as the moment to build, with no revision', async () => {
    const { app, service } = buildApp();
    const path = route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits(), PathSegment.done());

    const response = await post(app, path, {});

    // 204: this is not a write and there is no new state to report - the client is
    // navigating away as it calls it.
    expect(response.status).toBe(204);
    expect(service.finish).toHaveBeenCalledWith('p1', undefined);

    await post(app, path, { opened: { doc: neutralEdits(), stamp: 'stamp' } });
    expect(service.finish).toHaveBeenLastCalledWith('p1', { doc: neutralEdits(), stamp: 'stamp' });
  });

  it('reports a revision that has moved on as a conflict rather than a failure', async () => {
    const { app } = buildApp({
      save: jest.fn(() => {
        throw new AppError('CONFLICT', 'these edits have moved on');
      }) as unknown as PhotoEditsService['save'],
    });

    const response = await put(app, route(PathSegment.api(), PathSegment.photos(), 'p1', PathSegment.edits()), {
      doc: neutralEdits(),
      rev: 0,
      session: 'anopensession',
    });

    // 409 is what tells a client to refetch and reapply rather than retry as-is.
    expect(response.status).toBe(409);
  });

  it('reports an unknown photo as not found', async () => {
    const { app } = buildApp({
      get: jest.fn(() => {
        throw new AppError('NOT_FOUND', 'photo not found: nope');
      }) as unknown as PhotoEditsService['get'],
    });

    expect((await app.request(route(PathSegment.api(), PathSegment.photos(), 'nope', PathSegment.edits()))).status).toBe(404);
  });
});

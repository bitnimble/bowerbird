import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import { neutralEdits, type EditState } from '../../../schemas/photo_edits';
import type { PhotoEditsService } from '../../../services/photo_edits/photo_edits_service';
import { PhotoEditsApi } from '../photo_edits_api';

const state: EditState = { doc: neutralEdits(), rev: 1, canUndo: true, canRedo: false };

function buildApp(over: Partial<PhotoEditsService> = {}) {
  const service = {
    get: jest.fn(() => state),
    save: jest.fn(() => state),
    undo: jest.fn(() => state),
    redo: jest.fn(() => state),
    finish: jest.fn(),
    ...over,
  } as unknown as PhotoEditsService;
  const app = new Hono();
  app.route('/api', new PhotoEditsApi(service).routes);
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

    const response = await app.request('/api/photos/p1/edits');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(state);
    expect(service.get).toHaveBeenCalledWith('p1');
  });

  it('passes the whole document and its revision through to the service', async () => {
    const { app, service } = buildApp();
    const doc = { ...neutralEdits(), exposure: 1.25 };

    const response = await app.request('/api/photos/p1/edits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc, rev: 3 }),
    });

    expect(response.status).toBe(200);
    expect(service.save).toHaveBeenCalledWith('p1', expect.objectContaining({ exposure: 1.25 }), 3);
  });

  it('refuses a save that states no revision', async () => {
    const { app, service } = buildApp();

    const response = await put(app, '/api/photos/p1/edits', { doc: neutralEdits() });

    // Optional would defeat the point: a client that omits it is exactly the one
    // that would overwrite another tab's edit.
    expect(response.status).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('refuses a document whose values are out of range', async () => {
    const { app, service } = buildApp();

    const response = await app.request('/api/photos/p1/edits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doc: { ...neutralEdits(), exposure: 99 }, rev: 0 }),
    });

    expect(response.status).toBe(400);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('steps back and forward, each carrying the revision it was read at', async () => {
    const { app, service } = buildApp();

    expect((await post(app, '/api/photos/p1/edits/undo', { rev: 2 })).status).toBe(200);
    expect((await post(app, '/api/photos/p1/edits/redo', { rev: 2 })).status).toBe(200);

    expect(service.undo).toHaveBeenCalledWith('p1', 2);
    expect(service.redo).toHaveBeenCalledWith('p1', 2);
  });

  it('takes the editor closing as the moment to build, with no body and no revision', async () => {
    const { app, service } = buildApp();

    const response = await post(app, '/api/photos/p1/edits/done', {});

    // 204: this is not a write and there is no new state to report - the client is
    // navigating away as it calls it.
    expect(response.status).toBe(204);
    expect(service.finish).toHaveBeenCalledWith('p1');
  });

  it('reports a revision that has moved on as a conflict rather than a failure', async () => {
    const { app } = buildApp({
      save: jest.fn(() => {
        throw new AppError('CONFLICT', 'these edits have moved on');
      }) as unknown as PhotoEditsService['save'],
    });

    const response = await put(app, '/api/photos/p1/edits', { doc: neutralEdits(), rev: 0 });

    // 409 is what tells a client to refetch and reapply rather than retry as-is.
    expect(response.status).toBe(409);
  });

  it('reports an unknown photo as not found', async () => {
    const { app } = buildApp({
      get: jest.fn(() => {
        throw new AppError('NOT_FOUND', 'photo not found: nope');
      }) as unknown as PhotoEditsService['get'],
    });

    expect((await app.request('/api/photos/nope/edits')).status).toBe(404);
  });
});

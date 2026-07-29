import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import type { Library, LibrarySyncStatus } from '../../../schemas/libraries';
import type { LibrariesService } from '../../../services/libraries/libraries_service';
import type { SyncService } from '../../../services/sync/sync_service';
import { LibrariesApi } from '../libraries_api';

const library: Library = { id: 'l1', root_path: '/r', data_path: null, ordering: 'taken_desc',
  rendition_source: 'embedded' as const,
  rendition_hdr: false,
  rendition_hdr_video: false, last_synced_at: null, photo_count: 0 };
const status = { library_id: 'l1', status: 'processing', photos_added: 3 } as LibrarySyncStatus;

function buildApp(lib: Partial<LibrariesService> = {}, sync: Partial<SyncService> = {}) {
  const libraries = {
    create: jest.fn(async () => library),
    list: jest.fn(() => [library]),
    get: jest.fn(() => library),
    delete: jest.fn(),
    ...lib,
  } as unknown as LibrariesService;
  const syncSvc = {
    syncLibrary: jest.fn(async () => status),
    getSyncStatus: jest.fn(() => status),
    ...sync,
  } as unknown as SyncService;
  const app = new Hono();
  app.route('/api/libraries', new LibrariesApi(libraries, syncSvc).routes);
  applyErrorHandler(app);
  return { app, libraries, sync: syncSvc };
}

describe('LibrariesApi', () => {
  it('creates a library (201)', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/libraries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '/r' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects an empty root_path (400 envelope)', async () => {
    const { app } = buildApp();
    const res = await app.request('/api/libraries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('maps a CONFLICT from the service', async () => {
    const { app } = buildApp({ create: jest.fn(() => { throw new AppError('CONFLICT', 'dup'); }) });
    const res = await app.request('/api/libraries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '/r' }),
    });
    expect(res.status).toBe(409);
  });

  it('triggers a sync and returns its status', async () => {
    const syncLibrary = jest.fn(async () => status);
    const { app } = buildApp({}, { syncLibrary });
    const res = await app.request('/api/libraries/l1/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(syncLibrary).toHaveBeenCalledWith('l1');
  });

  it('returns 409 when a sync is already running', async () => {
    const { app } = buildApp({}, { syncLibrary: jest.fn(() => { throw new AppError('SYNC_IN_PROGRESS', 'busy'); }) });
    const res = await app.request('/api/libraries/l1/sync', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('deletes a library (204)', async () => {
    const del = jest.fn();
    const { app } = buildApp({ delete: del });
    const res = await app.request('/api/libraries/l1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith('l1');
  });
});

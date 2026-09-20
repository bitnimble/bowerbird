import { describe, expect, it, jest } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { AssemblyRecipeSchema } from '../../../schemas/assembly';
import type { CompositesService } from '../../../services/composites/composites_service';
import type { PhotoReadService } from '../../../services/photos/listing/photo_read_service';
import { applyErrorHandler } from '../../error_handler';
import { CompositesApi } from '../composites_api';

const RECIPE = AssemblyRecipeSchema.parse(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dir, '..', '..', '..', '..', 'test', 'fixtures', 'assembly-recipe.json'),
      'utf8',
    ),
  ),
);

function buildApp(composites: Partial<CompositesService> = {}) {
  const service = {
    mergePanorama: jest.fn(async () => ({ photoId: 'made' })),
    startAssembly: jest.fn(() => 'job1'),
    assemblyJob: jest.fn((id: string) =>
      id === 'job1' ? { id, photoIds: ['photo001'], status: 'analysing', fraction: 0.4 } : null,
    ),
    cancelAssembly: jest.fn(),
    reopenAssembly: jest.fn(async () => ({ recipe: RECIPE, layers: ['/image/drafts/lib/key/0'], missingSources: [] })),
    commitAssembly: jest.fn(async () => ({ photoId: 'made' })),
    updateAssembly: jest.fn(async () => ({ photoId: 'made' })),
    ...composites,
  } as unknown as CompositesService;
  const photos = {
    resolve: jest.fn((target: { photo_ids?: string[] }) => target.photo_ids ?? []),
  } as unknown as PhotoReadService;
  const app = new Hono();
  app.route('/api/composites', new CompositesApi(service, photos).routes);
  applyErrorHandler(app);
  return { app, service };
}

async function post(app: Hono, at: string, body?: unknown): Promise<Response> {
  return await app.request(at, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  });
}

describe('CompositesApi, the assembly half', () => {
  it('starts a carve and answers its job', async () => {
    const { app, service } = buildApp();

    const res = await post(app, '/api/composites/assembly', { photo_ids: ['photo001', 'photo002'] });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ jobId: 'job1' });
    expect(service.startAssembly).toHaveBeenCalledWith(['photo001', 'photo002']);
  });

  it('reports the services refusal rather than a 500', async () => {
    const { app } = buildApp({
      startAssembly: jest.fn(() => {
        throw new AppError('VALIDATION_ERROR', 'an assembly is made of at most 12 photographs');
      }),
    });

    const res = await post(app, '/api/composites/assembly', { photo_ids: ['photo001'] });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('at most 12');
  });

  it('refuses a target naming no photographs at all', async () => {
    const { app, service } = buildApp();

    const res = await post(app, '/api/composites/assembly', {});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(service.startAssembly).not.toHaveBeenCalled();
  });

  it('answers a job as it stands, and 404 for one it does not hold', async () => {
    const { app } = buildApp();

    const held = await app.request('/api/composites/assembly/jobs/job1');
    expect(held.status).toBe(200);
    expect(await held.json()).toMatchObject({ status: 'analysing', fraction: 0.4 });

    expect((await app.request('/api/composites/assembly/jobs/gone')).status).toBe(404);
  });

  it('cancels by job', async () => {
    const { app, service } = buildApp();

    const res = await post(app, '/api/composites/assembly/jobs/job1/cancel');

    expect(res.status).toBe(204);
    expect(service.cancelAssembly).toHaveBeenCalledWith('job1');
  });

  it('commits the recipe the reader finished', async () => {
    const { app, service } = buildApp();

    const res = await post(app, '/api/composites/assembly/commit', { recipe: RECIPE });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ photoId: 'made' });
    expect(service.commitAssembly).toHaveBeenCalled();
  });

  it('refuses a commit whose picks disagree with its tiles', async () => {
    const { app, service } = buildApp();

    const res = await post(app, '/api/composites/assembly/commit', { recipe: { ...RECIPE, pick: [0] } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(service.commitAssembly).not.toHaveBeenCalled();
  });

  // §2.7: the page opens a finished assembly by the photograph, and draws it from the same layers
  // a draft is drawn from.
  it('answers a finished assemblys recipe and its layers', async () => {
    const { app, service } = buildApp();

    const res = await app.request('/api/composites/assembly/photo000000000001');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ layers: ['/image/drafts/lib/key/0'], missingSources: [] });
    expect(service.reopenAssembly).toHaveBeenCalledWith('photo000000000001');
  });

  it('reopens an assembly in place', async () => {
    const { app, service } = buildApp();

    const res = await app.request('/api/composites/assembly/photo000000000001', {
      method: 'PUT',
      body: JSON.stringify({ recipe: RECIPE }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(service.updateAssembly).toHaveBeenCalledWith('photo000000000001', expect.anything());
  });
});

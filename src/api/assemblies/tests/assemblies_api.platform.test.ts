import { describe, expect, it, jest } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { AssemblyRecipeSchema } from '../../../schemas/assembly';
import type { CompositesService } from '../../../services/composites/composites_service';
import { dataPathForLibraryId, draftLayerPath, draftPreviewPath } from '../../../utils/paths';
import { applyErrorHandler } from '../../error_handler';
import { AssembliesApi } from '../assemblies_api';

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
    solveSeams: jest.fn(async () => [RECIPE.seams!]),
    previewOf: jest.fn(async () => '/image/drafts/lib/key/preview-abc'),
    ...composites,
  } as unknown as CompositesService;
  const app = new Hono();
  app.route('/api/assemblies', new AssembliesApi(service).routes);
  applyErrorHandler(app);
  return { app, service };
}

async function ask(app: Hono, body: unknown): Promise<Response> {
  return await app.request('/api/assemblies/seams', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AssembliesApi', () => {
  it('answers the seams solved for each pick set', async () => {
    const { app, service } = buildApp();

    const res = await ask(app, { recipe: RECIPE, picks: [RECIPE.pick] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ seams: [RECIPE.seams] });
    expect(service.solveSeams).toHaveBeenCalledWith(RECIPE, [RECIPE.pick]);
  });

  it('answers where this recipe is rendered', async () => {
    const { app, service } = buildApp();

    const res = await app.request('/api/assemblies/preview', {
      method: 'POST',
      body: JSON.stringify({ recipe: RECIPE }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: '/image/drafts/lib/key/preview-abc' });
    expect(service.previewOf).toHaveBeenCalledWith(RECIPE);
  });

  it('404s by name when a source has gone', async () => {
    const { app } = buildApp({
      solveSeams: jest.fn(() => Promise.reject(new AppError('NOT_FOUND', 'photo002 is gone'))),
    });

    const res = await ask(app, { recipe: RECIPE, picks: [RECIPE.pick] });

    expect(res.status).toBe(404);
    expect(await res.text()).toContain('gone');
  });

  it.each([
    ['a recipe whose picks disagree with its tiles', { recipe: { ...RECIPE, pick: [0] }, picks: [RECIPE.pick] }],
    ['a pick set one short of the tiles', { recipe: RECIPE, picks: [[0]] }],
    ['a request carrying no recipe at all', { picks: [RECIPE.pick] }],
  ])('refuses %s', async (_, body) => {
    const { app, service } = buildApp();

    const res = await ask(app, body);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(service.solveSeams).not.toHaveBeenCalled();
  });
});

/** §4.3's layers, which the page loads as pictures: a file per source under a draft's layer key. */
describe('AssembliesApi.imageRoutes', () => {
  const LIB = 'assembly-layer-route-test';
  const KEY = 'a1b2c3d4';

  function layerApp(): Hono {
    const app = new Hono();
    app.route('/image', new AssembliesApi({} as unknown as CompositesService).imageRoutes);
    applyErrorHandler(app);
    return app;
  }

  it('serves the layer a carve wrote', async () => {
    const at = draftLayerPath(dataPathForLibraryId(LIB), KEY, 1);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, 'avif');

    const res = await layerApp().request(`/image/drafts/${LIB}/${KEY}/1`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/avif');
    expect(await res.text()).toBe('avif');
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });

  it('serves a settled preview beside the layers', async () => {
    const picture = 'f'.repeat(32);
    const at = draftPreviewPath(dataPathForLibraryId(LIB), KEY, picture);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, 'rendered');

    const res = await layerApp().request(`/image/drafts/${LIB}/${KEY}/preview-${picture}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('rendered');
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });

  it('refuses a preview named anything but a hash', async () => {
    const res = await layerApp().request(`/image/drafts/${LIB}/${KEY}/preview-..%2F..%2Fseams`);

    expect(res.status).toBe(404);
  });

  it('404s a layer the reaper has taken', async () => {
    const res = await layerApp().request(`/image/drafts/${LIB}/${KEY}/7`);

    expect(res.status).toBe(404);
  });

  // Nothing here reads a row, so a segment that is not a name is the one way this could be asked
  // to open a file outside the library's data directory.
  it('refuses a key that is a path rather than a name, with the file it would have reached in place', async () => {
    const outside = path.join(dataPathForLibraryId(LIB), 'analysis', '0.avif');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, 'not a layer');

    const res = await layerApp().request(`/image/drafts/${LIB}/..%2Fanalysis/0`);

    expect(res.status).toBe(404);
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });
});

import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { StoredRecipe } from '../../../schemas/recipes';
import { PathSegment, route } from '../../../schemas/route';
import { dataPathForLibraryId } from '../../../utils/paths';
import { applyErrorHandler } from '../../error_handler';
import { ImageApi } from '../image_api';

/**
 * **One request, answered by the recipe.** Asking for the cameras' own picture of a row is the
 * same question whatever the row is: one that names a file has that picture inside the file and
 * hands it over, one composed out of others has its frames' composited into a copy on disk.
 * Nothing about the asking may differ, or a client has to know which kind of row it is looking
 * at before it can name a URL.
 *
 * The stored copy is the half that can be pinned without a RAW to lift anything out of: the same
 * id and the same URL reach it under one recipe and not under the other.
 */
const LIB = 'lib-embedded-route';

function serving(recipe: StoredRecipe): Hono {
  const photos = {
    locate: () => ({ library: { id: LIB }, photo: { id: 'p1', file_path: null, recipe } }),
    rebuildIfStale: () => undefined,
  };
  const app = new Hono();
  app.route(
    route(PathSegment.image()),
    new ImageApi(
      {} as ConstructorParameters<typeof ImageApi>[0],
      photos as unknown as ConstructorParameters<typeof ImageApi>[1],
      null,
      {} as ConstructorParameters<typeof ImageApi>[3],
    ).routes,
  );
  applyErrorHandler(app);
  return app;
}

const stored = path.join(dataPathForLibraryId(LIB), 'renditions', 'embedded');
mkdirSync(stored, { recursive: true });
writeFileSync(path.join(stored, 'p1.avif'), 'canvas');
afterAll(() => rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true }));

const PANORAMA = {
  kind: 'panorama',
  version: 1,
  sources: [{ photoId: 'f1' }, { photoId: 'f2' }],
} as unknown as StoredRecipe;

it('serves the composited camera view of a row that names no file of its own', async () => {
  const answer = await serving(PANORAMA).request(route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'));

  expect(answer.status).toBe(200);
  expect(await answer.text()).toBe('canvas');
});

// The same id and the same URL: a row that names a file goes to that file for its camera view,
// so it never reaches the copy above - what it does reach needs a RAW to lift a JPEG out of,
// which is `serveEmbedded`'s business rather than this route's.
it('goes to the file a row names rather than to a stored copy', async () => {
  const answer = await serving({ kind: 'file', path: 'nowhere/a.arw' }).request(
    route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
  );

  expect(answer.status).not.toBe(200);
});

import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { PathSegment, route } from '../../../schemas/route';
import { applyErrorHandler } from '../../error_handler';
import { localOriginals } from '../../../services/blobs/originals_for_testing';
import { ImageApi } from '../image_api';

const ROOT = path.join(tmpdir(), `bowerbird-original-route-${process.pid}`);

function serving(recipe: unknown): Hono {
  const photos = {
    locate: () => ({
      library: { id: 'lib-original-route', root_path: ROOT },
      photo: { id: 'p1', recipe },
    }),
  };
  const app = new Hono();
  app.route(
    route(PathSegment.image()),
    new ImageApi(
      {} as ConstructorParameters<typeof ImageApi>[0],
      photos as unknown as ConstructorParameters<typeof ImageApi>[1],
      null,
      localOriginals(),
      {} as ConstructorParameters<typeof ImageApi>[4],
    ).routes,
  );
  applyErrorHandler(app);
  return app;
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

it('answers where the RAW is on disk', async () => {
  mkdirSync(path.join(ROOT, 'Trip'), { recursive: true });
  writeFileSync(path.join(ROOT, 'Trip', 'a.arw'), 'raw');

  const answer = await serving({ kind: 'file', path: 'Trip/a.arw' }).request(
    route(PathSegment.image(), 'p1', PathSegment.original()),
  );

  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ path: path.join(ROOT, 'Trip', 'a.arw') });
});

it('refuses a photo whose RAW is not on this device', async () => {
  const answer = await serving({ kind: 'file', path: 'Trip/gone.arw' }).request(
    route(PathSegment.image(), 'p1', PathSegment.original()),
  );

  expect(answer.status).toBe(404);
});

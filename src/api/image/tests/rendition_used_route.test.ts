import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { PathSegment, route } from '../../../schemas/route';
import { localOriginals } from '../../../services/blobs/originals_for_testing';
import { dataPathForLibraryId } from '../../../utils/paths';
import { applyErrorHandler } from '../../error_handler';
import { ImageApi } from '../image_api';

const LIB = 'lib-rendition-used-route';

for (const variant of ['grid', 'full-hdr', 'max']) {
  const dir = path.join(dataPathForLibraryId(LIB), 'renditions', variant);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'p1.avif'), variant);
}
afterAll(() => rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true }));

function serving(hdr: boolean, used: string[]): Hono {
  const photos = {
    locate: () => ({
      library: { id: LIB, root_path: dataPathForLibraryId(LIB), rendition_hdr: hdr },
      photo: { id: 'p1', file_path: 'p1.arw', recipe: { kind: 'file', path: 'p1.arw' } },
    }),
    rebuildIfStale: () => undefined,
    markUsed: (photoId: string, variant: string) => used.push(`${photoId}:${variant}`),
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

async function serve(hdr: boolean, rendition: string): Promise<string[]> {
  const used: string[] = [];
  const answer = await serving(hdr, used).request(
    route(PathSegment.image(), 'p1', PathSegment.renditions(), rendition),
  );
  expect(answer.status).toBe(200);
  return used;
}

it('marks the stored variant it served as used', async () => {
  expect(await serve(true, 'full')).toEqual(['p1:full-hdr']);
  expect(await serve(false, 'max')).toEqual(['p1:max']);
});

it('marks nothing for a grid tile', async () => {
  expect(await serve(false, 'grid')).toEqual([]);
});

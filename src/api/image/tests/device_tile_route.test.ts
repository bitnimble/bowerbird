import { afterAll, expect, it, jest } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { PathSegment, route } from '../../../schemas/route';
import { localOriginals } from '../../../services/blobs/originals_for_testing';
import { dataPathForLibraryId } from '../../../utils/paths';
import { applyErrorHandler } from '../../error_handler';
import { ImageApi } from '../image_api';

const LIB = 'lib-device-tile-route';
const ROOT = path.join(dataPathForLibraryId(LIB), 'root');
const THUMBNAIL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

mkdirSync(ROOT, { recursive: true });
writeFileSync(path.join(ROOT, 'p1.jpg'), 'original');
const gridDir = path.join(dataPathForLibraryId(LIB), 'renditions', 'grid');
mkdirSync(gridDir, { recursive: true });
writeFileSync(path.join(gridDir, 'p1.avif'), 'ours');
afterAll(() => rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true }));

function serving(
  deviceTile: Uint8Array | null,
  { isDeviceTile = true } = {},
): {
  app: Hono;
  asked: ReturnType<typeof jest.fn>;
} {
  const asked = jest.fn(async () => deviceTile);
  const photos = {
    locate: () => ({
      library: { id: LIB, root_path: ROOT, rendition_hdr: false },
      photo: { id: 'p1', file_path: 'p1.jpg', recipe: { kind: 'file', path: 'p1.jpg' } },
    }),
    isDeviceTile: () => isDeviceTile,
    deviceTile: asked,
    rebuildIfStale: () => undefined,
    markUsed: () => undefined,
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
  return { app, asked };
}

const GRID = route(PathSegment.image(), 'p1', PathSegment.renditions(), 'grid');

it("serves the device's thumbnail as the grid tile", async () => {
  const { app } = serving(THUMBNAIL);
  const answer = await app.request(GRID);

  expect(answer.status).toBe(200);
  expect(answer.headers.get('Content-Type')).toBe('image/jpeg');
  expect(new Uint8Array(await answer.arrayBuffer())).toEqual(THUMBNAIL);
});

it('answers a revalidation off the original without asking the device', async () => {
  const { app, asked } = serving(THUMBNAIL);
  const etag = (await app.request(GRID)).headers.get('ETag') ?? '';
  asked.mockClear();

  const answer = await app.request(GRID, { headers: { 'If-None-Match': etag } });

  expect(answer.status).toBe(304);
  expect(asked).not.toHaveBeenCalled();
});

it('serves the tile on disk when the device cannot hand its thumbnail over', async () => {
  const answer = await serving(null).app.request(GRID);

  expect(answer.status).toBe(200);
  expect(await answer.text()).toBe('ours');
});

it('serves the tile on disk without asking the device where the tile is ours', async () => {
  const { app, asked } = serving(THUMBNAIL, { isDeviceTile: false });
  const answer = await app.request(GRID);

  expect(await answer.text()).toBe('ours');
  expect(asked).not.toHaveBeenCalled();
});

it("waits for the device's thumbnail for a preview, and not for a grid tile", async () => {
  const { app, asked } = serving(THUMBNAIL);

  await app.request(route(PathSegment.image(), 'p1', PathSegment.preview()));
  expect(asked).toHaveBeenLastCalledWith('p1', { wait: true });
  await app.request(GRID);
  expect(asked).toHaveBeenLastCalledWith('p1', { wait: false });
});

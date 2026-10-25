import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { StoredRecipe } from '../../../schemas/recipes';
import { PathSegment, route } from '../../../schemas/route';
import { dataPathForLibraryId } from '../../../utils/paths';
import { applyErrorHandler } from '../../error_handler';
import { localOriginals } from '../../../services/blobs/originals_for_testing';
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

function serving(
  recipe: StoredRecipe | ((photoId: string) => StoredRecipe),
  fetchThrough: ConstructorParameters<typeof ImageApi>[2] = null,
  cameraFileOf: (photoId: string) => string | null = () => null,
  rotate = 0,
): Hono {
  const photos = {
    locate: (photoId: string) => ({
      library: { id: LIB, root_path: dataPathForLibraryId(LIB) },
      photo: {
        id: photoId,
        file_path: null,
        recipe: typeof recipe === 'function' ? recipe(photoId) : recipe,
      },
    }),
    cameraFileOf,
    rebuildIfStale: () => undefined,
    markUsed: () => undefined,
  };
  const app = new Hono();
  app.route(
    route(PathSegment.image()),
    new ImageApi(
      { editOrientation: () => rotate } as unknown as ConstructorParameters<typeof ImageApi>[0],
      photos as unknown as ConstructorParameters<typeof ImageApi>[1],
      fetchThrough,
      localOriginals(),
      {} as ConstructorParameters<typeof ImageApi>[4],
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
  const answer = await serving(PANORAMA).request(
    route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
  );

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

  expect(answer.status).toBe(404);
});

it('asks a peer for the camera view when the file a row names is not on this device', async () => {
  const asked: string[] = [];
  const peer = {
    takesFromPeer: () => false,
    ensureCurrent: (photoId: string, rendition: string) => {
      asked.push(`${rendition} of ${photoId}`);
      return Promise.resolve();
    },
  } as unknown as ConstructorParameters<typeof ImageApi>[2];

  const answer = await serving({ kind: 'file', path: 'nowhere/a.arw' }, peer).request(
    route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
  );

  expect(asked).toEqual(['embedded of p1']);
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('image/jpeg');
  expect(await answer.text()).toBe('canvas');
});

it('streams a finished picture as the file it is', async () => {
  writeFileSync(path.join(dataPathForLibraryId(LIB), 'shot.png'), 'png bytes');

  const answer = await serving({ kind: 'file', path: 'shot.png' }).request(
    route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
  );

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('image/png');
  expect(await answer.text()).toBe('png bytes');
});

it('names a HEIC by its HEIF media type under each of its extensions', async () => {
  for (const [name, type] of [
    ['shot.heic', 'image/heic'],
    ['shot.hif', 'image/heif'],
  ]) {
    writeFileSync(path.join(dataPathForLibraryId(LIB), name!), 'heic bytes');
    const answer = await serving({ kind: 'file', path: name! }).request(
      route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
    );
    expect(answer.headers.get('content-type')).toBe(type!);
  }
});

it("serves a RAW's camera rendition as its linked JPEG's own file", async () => {
  writeFileSync(path.join(dataPathForLibraryId(LIB), 'DSC01234.JPG'), 'camera jpeg');
  const app = serving(
    (photoId) => ({ kind: 'file', path: photoId === 'jpeg' ? 'DSC01234.JPG' : 'DSC01234.ARW' }),
    null,
    (photoId) => (photoId === 'raw' ? 'jpeg' : null),
  );

  const answer = await app.request(
    route(PathSegment.image(), 'raw', PathSegment.renditions(), 'camera'),
  );
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('image/jpeg');
  expect(await answer.text()).toBe('camera jpeg');

  const unlinked = await app.request(
    route(PathSegment.image(), 'jpeg', PathSegment.renditions(), 'camera'),
  );
  expect(unlinked.status).toBe(404);
});

const hasBox = (bytes: Uint8Array, kind: string): boolean =>
  Buffer.from(bytes).includes(Buffer.from(kind));

it("turns a linked HEIF by the RAW's turn, in its own boxes", async () => {
  const heif = readFileSync(
    path.join(import.meta.dir, '../../../../test/fixtures/avif-planes/444.avif'),
  );
  expect(hasBox(heif, 'irot')).toBe(false);
  writeFileSync(path.join(dataPathForLibraryId(LIB), 'DSC01235.HEIC'), heif);
  const app = serving(
    (photoId) => ({ kind: 'file', path: photoId === 'heif' ? 'DSC01235.HEIC' : 'DSC01235.ARW' }),
    null,
    (photoId) => (photoId === 'raw' ? 'heif' : null),
    90,
  );

  const answer = await app.request(
    route(PathSegment.image(), 'raw', PathSegment.renditions(), 'camera'),
  );
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('image/heic');
  expect(hasBox(new Uint8Array(await answer.arrayBuffer()), 'irot')).toBe(true);
});

it("turns a linked JPEG a peer holds by the RAW's turn", async () => {
  writeFileSync(path.join(stored, 'peer-jpeg.avif'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const peer = {
    takesFromPeer: () => true,
    ensureCurrent: () => Promise.resolve(),
  } as unknown as ConstructorParameters<typeof ImageApi>[2];
  const app = serving(
    (photoId) => ({
      kind: 'file',
      path: photoId === 'peer-jpeg' ? 'DSC01236.JPG' : 'DSC01236.ARW',
    }),
    peer,
    (photoId) => (photoId === 'raw' ? 'peer-jpeg' : null),
    90,
  );

  const answer = await app.request(
    route(PathSegment.image(), 'raw', PathSegment.renditions(), 'camera'),
  );
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('image/jpeg');
  expect(hasBox(new Uint8Array(await answer.arrayBuffer()), 'Exif')).toBe(true);
});

it('serves a finished picture a peer sent under its own media type', async () => {
  const peer = {
    takesFromPeer: () => true,
    ensureCurrent: () => Promise.resolve(),
  } as unknown as ConstructorParameters<typeof ImageApi>[2];

  const answer = await serving({ kind: 'file', path: 'nowhere/a.avif' }, peer).request(
    route(PathSegment.image(), 'p1', PathSegment.renditions(), 'embedded'),
  );

  expect(answer.headers.get('content-type')).toBe('image/avif');
});

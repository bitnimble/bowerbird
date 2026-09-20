// The camera's JPEG is the one image response with no file of its own to stat:
// it is lifted out of the RAW per request. Without a validator the browser has
// nothing to revalidate against, so every element that mounts the same URL after
// its copy fell out of the in-memory cache re-fetches several megabytes - which
// is what stepping back and forth between two frames does (§13.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ImageApi } from '../../src/api/image/image_api';

const FIXTURES = `${import.meta.dir}/../fixtures`;

function serving(edit: { rotate: number } = { rotate: 0 }): Hono {
  const photoRenditions = {
    // The recipe is where the file is: the route lifts the JPEG out of the row's sole input.
    locate: () => ({
      library: { root_path: FIXTURES },
      photo: { id: 'p1', recipe: { kind: 'file', path: 'DSC02981.ARW' } },
    }),
    // Serving one queues a rebuild where the copy is behind its edits; nothing here asserts on it.
    rebuildIfStale: () => {},
  };
  const photoRead = { editOrientation: () => edit.rotate };
  const app = new Hono();
  app.route(
    '/image',
    new ImageApi(
      photoRead as unknown as ConstructorParameters<typeof ImageApi>[0],
      photoRenditions as unknown as ConstructorParameters<typeof ImageApi>[1],
      null,
      {} as ConstructorParameters<typeof ImageApi>[3],
    ).routes,
  );
  return app;
}

test('the camera JPEG revalidates instead of being sent again', async () => {
  const app = serving();

  const first = await app.request('/image/p1/renditions/embedded');
  expect(first.status).toBe(200);
  const etag = first.headers.get('etag');
  expect(etag).not.toBeNull();
  expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(0);

  const again = await app.request('/image/p1/renditions/embedded', { headers: { 'if-none-match': etag! } });
  expect(again.status).toBe(304);
  expect((await again.arrayBuffer()).byteLength).toBe(0);
});

test('a stale validator is served the bytes', async () => {
  const app = serving();

  const stale = await app.request('/image/p1/renditions/embedded', { headers: { 'if-none-match': '"0-0"' } });
  expect(stale.status).toBe(200);
  expect((await stale.arrayBuffer()).byteLength).toBeGreaterThan(0);
});

test('a rotation edit changes embedded JPEG metadata and validator', async () => {
  const edit = { rotate: 0 };
  const app = serving(edit);
  const first = await app.request('/image/p1/renditions/embedded');
  const before = Buffer.from(await first.arrayBuffer());
  const etag = first.headers.get('etag');
  expect(etag).not.toBeNull();

  edit.rotate = 180;
  const second = await app.request('/image/p1/renditions/embedded', { headers: { 'if-none-match': etag! } });
  expect(second.status).toBe(200);
  expect(second.headers.get('etag')).not.toBe(etag);
  expect(Buffer.from(await second.arrayBuffer()).equals(before)).toBe(false);
});

import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { writeCameraMatch } from '../../../services/processing/camera_match_store';
import { dataPathForLibraryId } from '../../../utils/paths';
import { ImageApi } from '../image_api';

// A match is a function of the RAW alone, so the interesting behaviour here is not the write - it
// is that a client cannot replace one already on disk, which is what keeps the rendition worker's
// authoritative when a tab fits its own at the same time.
// Keyed by the library's *id*, which is what `getDataPath` reads - a `data_path` on the mock would
// be ignored and every test here would share one directory.
function serving(libraryId: string): Hono {
  const photos = {
    locate: () => ({ library: { id: libraryId }, photo: { file_path: 'a.arw' } }),
  };
  const app = new Hono();
  app.route(
    '/image',
    new ImageApi(
      photos as unknown as ConstructorParameters<typeof ImageApi>[0],
      { get: () => undefined } as unknown as ConstructorParameters<typeof ImageApi>[1],
      { renderTile: (async () => new Uint8Array()) as unknown as ConstructorParameters<
        typeof ImageApi
      >[2]['renderTile'] },
    ).routes,
  );
  return app;
}

function matchOf(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

describe('PUT /image/:photoId/camera-match', () => {
  it('keeps a match the client fitted, so the next open does not fit it again', async () => {
    const app = serving('lib-keeps');

    const put = await app.request('/image/p1/camera-match', {
      method: 'PUT',
      body: matchOf(5000, 7),
    });
    expect(put.status).toBe(204);

    const got = await app.request('/image/p1/camera-match');
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())[0]).toBe(7);
  });

  it('will not overwrite one already on disk', async () => {
    writeCameraMatch(dataPathForLibraryId('lib-keeps-first'), 'p1', matchOf(5000, 1));
    const app = serving('lib-keeps-first');

    const put = await app.request('/image/p1/camera-match', {
      method: 'PUT',
      body: matchOf(5000, 2),
    });
    expect(put.status).toBe(204);

    const got = await app.request('/image/p1/camera-match');
    expect(new Uint8Array(await got.arrayBuffer())[0]).toBe(1);
  });

  it('refuses a body that is not a match', async () => {
    const app = serving('lib-refuses');

    const tiny = await app.request('/image/p1/camera-match', { method: 'PUT', body: matchOf(8, 1) });
    expect(tiny.status).toBeGreaterThanOrEqual(400);

    const huge = await app.request('/image/p1/camera-match', {
      method: 'PUT',
      body: matchOf(200 * 1024, 1),
    });
    expect(huge.status).toBeGreaterThanOrEqual(400);
  });
});

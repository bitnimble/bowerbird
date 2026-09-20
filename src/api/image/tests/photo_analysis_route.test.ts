import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { PathSegment, route } from '../../../schemas/route';
import { writePhotoAnalysis } from '../../../services/processing/analysis/photo_analysis_store';
import { dataPathForLibraryId } from '../../../utils/paths';
import { ImageApi } from '../image_api';

// Keyed by the library's *id*, which is what `getDataPath` reads - a `data_path` on the mock would
// be ignored and every test here would share one directory.
function serving(libraryId: string): Hono {
  const photos = {
    locate: () => ({ library: { id: libraryId }, photo: { file_path: 'a.arw' } }),
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
  return app;
}

function analysisOf(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

describe('PUT /image/:photoId/analysis', () => {
  it('keeps what the client measured, so the next open does not measure it again', async () => {
    const app = serving('lib-keeps');

    const put = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()), {
      method: 'PUT',
      body: analysisOf(5000, 7),
    });
    expect(put.status).toBe(204);

    const got = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()));
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())[0]).toBe(7);
  });

  // **The file grows.** A client sends back everything it was handed plus what it worked out, so a
  // later write is normally a superset of the earlier one - and refusing it, as this route once
  // did, would pin the photograph to whatever the first caller happened to have measured.
  it('takes a later write over one already on disk', async () => {
    writePhotoAnalysis(dataPathForLibraryId('lib-takes-later'), 'p1', analysisOf(5000, 1));
    const app = serving('lib-takes-later');

    const put = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()), {
      method: 'PUT',
      body: analysisOf(6000, 2),
    });
    expect(put.status).toBe(204);

    const got = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()));
    expect(new Uint8Array(await got.arrayBuffer())[0]).toBe(2);
  });

  it('refuses a body too large to be an analysis', async () => {
    const app = serving('lib-refuses');

    const huge = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()), {
      method: 'PUT',
      body: analysisOf(8 * 1024 * 1024, 1),
    });
    expect(huge.status).toBeGreaterThanOrEqual(400);
  });

  it('keeps a body with nothing in it at all', async () => {
    const app = serving('lib-keeps-nothing');

    const kept = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()), { method: 'PUT', body: new Uint8Array() });
    expect(kept.status).toBe(204);
  });

  // A photograph whose cover glass was read and found clean stores an empty particle list and
  // nothing else. That is a dozen bytes, and it is the answer that stops the next open searching
  // the whole mosaic again - so "small" cannot mean "malformed" here.
  it('keeps an analysis that says only that nothing was found', async () => {
    const app = serving('lib-keeps-empty');

    const kept = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()), { method: 'PUT', body: analysisOf(13, 1) });
    expect(kept.status).toBe(204);

    const got = await app.request(route(PathSegment.image(), 'p1', PathSegment.analysis()));
    expect(got.status).toBe(200);
    expect((await got.arrayBuffer()).byteLength).toBe(13);
  });

});

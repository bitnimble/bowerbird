import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { PathSegment, route } from '../../../schemas/route';
import { applyErrorHandler } from '../../error_handler';
import { ImageApi } from '../image_api';

// What the route does with a picture, and what it does instead of one.
//
// The prepare itself is `picture::prepared`, and what it produces is held to a rendition natively;
// this is the boundary around it - that the body is passed through whole, that a refusal names its
// reason, and that a server with no prepare behind it says so rather than answering an empty
// picture.

/** A framed reply of `samples` samples, as the library writes one. */
function framed(header: object, samples: number): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(header));
  const at = 4 + Math.ceil(text.byteLength / 4) * 4;
  const out = new Uint8Array(at + samples * 2);
  new DataView(out.buffer).setUint32(0, text.byteLength, true);
  out.set(text, 4);
  // Anything non-zero: what a caller checks is the length, and a picture of zeroes is the one
  // failure a length cannot show.
  out.fill(9, at);
  return out;
}

function serving(
  pictures: {
    preparePicture: (photoId: string, shown?: unknown, missing?: unknown, develop?: unknown) => Promise<Uint8Array>;
  } | null,
): Hono {
  const photos = {
    locate: (photoId: string) => {
      if (photoId === 'gone') throw new AppError('NOT_FOUND', `photo not found: ${photoId}`);
      return { library: { id: 'lib' }, photo: { file_path: 'a.arw' } };
    },
  };
  const app = new Hono();
  app.route(
    route(PathSegment.image()),
    new ImageApi(
      {} as ConstructorParameters<typeof ImageApi>[0],
      photos as unknown as ConstructorParameters<typeof ImageApi>[1],
      null,
      {} as ConstructorParameters<typeof ImageApi>[3],
      pictures,
    ).routes,
  );
  applyErrorHandler(app);
  return app;
}

describe('GET /image/:photoId/prepare', () => {
  it('hands the frame over whole, and says nothing about it', async () => {
    const body = framed({ width: 40, height: 30 }, 40 * 30 * 3);
    const app = serving({ preparePicture: async () => body });

    const got = await app.request(route(PathSegment.image(), 'p1', PathSegment.prepare()));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    const back = new Uint8Array(await got.arrayBuffer());
    expect(back.byteLength).toBe(body.byteLength);

    // The header states its own length and the samples follow it on a word, which is the one
    // thing a client cannot recover if this route reshaped the body.
    const stated = new DataView(back.buffer, back.byteOffset).getUint32(0, true);
    const at = 4 + Math.ceil(stated / 4) * 4;
    expect(at % 4).toBe(0);
    expect((back.byteLength - at) / 2).toBe(40 * 30 * 3);
  });

  // **Never stored.** It is tens to a hundred megabytes and a function of a library setting, the
  // document and every source's analysis - so an entry that outlived any of those would serve a
  // picture the grade is no longer anchored to.
  it('is never cached', async () => {
    const app = serving({ preparePicture: async () => framed({ width: 2, height: 2 }, 12) });
    const got = await app.request(route(PathSegment.image(), 'p1', PathSegment.prepare()));
    expect(got.headers.get('cache-control')).toBe('no-store');
  });

  // What the reader is previewing and has not saved: the denoise, the sharpen and the dust run
  // before the samples cross, so the stored document alone would prepare the last save.
  it('passes the Detail and dust being previewed through, and drops a malformed one', async () => {
    const develops: unknown[] = [];
    const app = serving({
      preparePicture: async (_photoId, _shown, _missing, develop) => {
        develops.push(develop);
        return framed({ width: 2, height: 2 }, 12);
      },
    });
    const develop = {
      luminanceNoise: 30,
      colourNoise: null,
      sharpening: 80,
      dustRemoval: false,
      dustSensitivity: 25,
      dustIntensity: 100,
    };
    const url = route(PathSegment.image(), 'p1', PathSegment.prepare());
    await app.request(`${url}?develop=${encodeURIComponent(JSON.stringify(develop))}`);
    await app.request(`${url}?develop=${encodeURIComponent(JSON.stringify({ ...develop, sharpening: 900 }))}`);
    await app.request(`${url}?develop=not-json`);

    expect(develops).toEqual([develop, undefined, undefined]);
  });

  it('refuses a photograph nothing knows about', async () => {
    const app = serving({ preparePicture: async () => framed({ width: 2, height: 2 }, 12) });
    const got = await app.request(route(PathSegment.image(), 'gone', PathSegment.prepare()));
    expect(got.status).toBe(404);
  });

  // The reason a reader can act on: a composite whose frames are not on this device, a recipe this
  // build cannot read. Carried through rather than turned into a status code, because the editor
  // shows it in the panel.
  it('carries the reason a prepare was refused', async () => {
    const app = serving({
      preparePicture: () => {
        throw new AppError('NOT_FOUND', 'p1 is composed from frames this device does not hold');
      },
    });
    const got = await app.request(route(PathSegment.image(), 'p1', PathSegment.prepare()));
    expect(got.status).toBe(404);
    expect(await got.text()).toContain('frames this device does not hold');
  });

  it('says so where the server prepares no pictures at all', async () => {
    const got = await serving(null).request(route(PathSegment.image(), 'p1', PathSegment.prepare()));
    expect(got.status).toBe(404);
    expect(await got.text()).toContain('does not prepare pictures');
  });
});

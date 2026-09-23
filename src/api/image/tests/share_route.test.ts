import { afterAll, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { StoredRecipe } from '../../../schemas/recipes';
import { PathSegment, route } from '../../../schemas/route';
import { dataPathForLibraryId } from '../../../utils/paths';
import { applyErrorHandler } from '../../error_handler';
import { localOriginals } from '../../../services/blobs/originals_for_testing';
import { ShareService } from '../../../services/processing/exports/share_service';
import { ImageApi } from '../image_api';

/**
 * **What a share sheet is handed is a JPEG, and which file it was made from is the route's
 * answer rather than the client's.** The client names the rendition it is showing; whether that
 * rendition is HDR - and so whether the JPEG needs a gain map to carry the picture - follows the
 * library, which is the same rule every other rendition route obeys.
 */
const LIB = 'lib-share-route';

interface Asked {
  photoId: string;
  renditionPath: string;
  hdr: boolean;
}

function serving(renditionHdr: boolean, recipe: StoredRecipe = { kind: 'file', path: 'a.arw' }): { app: Hono; asked: Asked[] } {
  const asked: Asked[] = [];
  const photos = {
    locate: () => ({
      library: { id: LIB, rendition_hdr: renditionHdr, root_path: '/nonexistent/lib-share-route' },
      photo: { id: 'p1', file_path: null, recipe },
    }),
    rebuildIfStale: () => undefined,
  };
  const exports = {
    shareable: (photoId: string, renditionPath: string, hdr: boolean) => {
      asked.push({ photoId, renditionPath, hdr });
      return Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff]));
    },
  };
  const app = new Hono();
  app.route(
    route(PathSegment.image()),
    new ImageApi(
      {} as ConstructorParameters<typeof ImageApi>[0],
      photos as unknown as ConstructorParameters<typeof ImageApi>[1],
      null,
      localOriginals(),
      new ShareService(photos as unknown as ConstructorParameters<typeof ShareService>[0], localOriginals(), { editOrientation: () => 0 }, exports),
    ).routes,
  );
  applyErrorHandler(app);
  return { app, asked };
}

function stored(variant: string): string {
  const directory = path.join(dataPathForLibraryId(LIB), 'renditions', variant);
  mkdirSync(directory, { recursive: true });
  const at = path.join(directory, 'p1.avif');
  writeFileSync(at, 'render');
  return at;
}

afterAll(() => rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true }));

it('shares the HDR file of an HDR library, and says that is what it is', async () => {
  const at = stored('max-hdr');
  const { app, asked } = serving(true);

  const answer = await app.request(route(PathSegment.image(), 'p1', PathSegment.share(), 'max'));

  expect(answer.status).toBe(200);
  expect(answer.headers.get('Content-Type')).toBe('image/jpeg');
  expect(asked).toEqual([{ photoId: 'p1', renditionPath: at, hdr: true }]);
});

// The same route, the same rendition, and a different file with a different answer about the
// gain map: an SDR library's renditions have no range to carry.
it('shares the SDR file of an SDR library', async () => {
  const at = stored('full');
  const { app, asked } = serving(false);

  const answer = await app.request(route(PathSegment.image(), 'p1', PathSegment.share(), 'full'));

  expect(answer.status).toBe(200);
  expect(asked).toEqual([{ photoId: 'p1', renditionPath: at, hdr: false }]);
});

// Nothing is built to be shared: the client is sharing what it has on screen, and a rendition
// that is not on disk is not on screen either.
it('refuses a rendition that has not been built', async () => {
  const { app, asked } = serving(false);

  const answer = await app.request(route(PathSegment.image(), 'p1', PathSegment.share(), 'max'));

  expect(answer.status).toBe(404);
  expect(asked).toEqual([]);
});

// A composite has no file to lift a JPEG out of, so its camera view is the stored copy, transcoded.
it("shares a composite's stored camera view", async () => {
  const at = stored('embedded');
  const panorama = { kind: 'panorama', version: 1, sources: [{ photoId: 'f1' }, { photoId: 'f2' }] } as unknown as StoredRecipe;
  const { app, asked } = serving(true, panorama);

  const answer = await app.request(route(PathSegment.image(), 'p1', PathSegment.share(), 'embedded'));

  expect(answer.status).toBe(200);
  expect(asked).toEqual([{ photoId: 'p1', renditionPath: at, hdr: false }]);
});

// A row that names a file lifts the camera's JPEG out of it, and nothing is transcoded.
it("refuses the camera's JPEG of a file that is not here", async () => {
  const { app, asked } = serving(false, { kind: 'file', path: 'nowhere/a.arw' });

  const answer = await app.request(route(PathSegment.image(), 'p1', PathSegment.share(), 'embedded'));

  expect(answer.status).toBe(404);
  expect(asked).toEqual([]);
});

// A tile is a listing's picture and never what the viewer is showing, so it is not shareable
// even though it is a rendition by name.
it('refuses the grid tile', async () => {
  const { app, asked } = serving(true);

  const answer = await app.request(route(PathSegment.image(), 'p1', PathSegment.share(), 'grid'));

  expect(answer.status).toBe(404);
  expect(asked).toEqual([]);
});

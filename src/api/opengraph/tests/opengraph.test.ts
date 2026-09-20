import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import type { PhotoDetail, PhotoListQuery, PhotoListResponse, PhotoSummary } from '../../../schemas/photos';
import { PathSegment, route } from '../../../schemas/route';
import type { AlbumsService } from '../../../services/albums/albums_service';
import type { LibrariesService } from '../../../services/libraries/libraries_service';
import type { PhotoReadService } from '../../../services/photos/listing/photo_read_service';
import type { ShootsService } from '../../../services/shoots/shoots_service';
import { OpenGraph } from '../opengraph';

const SHELL = '<html><head><title>Bowerbird</title></head><body></body></html>';

const photo = {
  id: 'photo001',
  recipe: { kind: 'file', path: 'Trip/DSC_0001.NEF' },
  file_path: 'Trip/DSC_0001.NEF',
  tile_built_at: '2026-01-02T00:00:00.000Z',
  date_taken: '2025-12-31T18:30:00',
  camera_make: 'NIKON',
  camera_model: 'NIKON Z 8',
  lens_model: 'NIKKOR Z 50mm f/1.8 S',
  focal_length: 50,
  aperture: 1.8,
  shutter_speed: 0.004,
  iso: 100,
} as unknown as PhotoDetail;

function listing(photos: Partial<PhotoSummary>[], photoTotal: number): PhotoListResponse {
  return { photos: photos as PhotoSummary[], photo_total: photoTotal, offset: 0, limit: 1, ordering: 'taken_desc' };
}

function notFound(): never {
  throw new AppError('NOT_FOUND', 'gone');
}

function serving(): { app: Hono; asked: PhotoListQuery[] } {
  const asked: PhotoListQuery[] = [];
  const openGraph = new OpenGraph(
    { get: (id: string) => (id === 'lib00001' ? { name: 'Everything' } : notFound()) } as unknown as LibrariesService,
    { get: () => ({ name: 'Trip "<2025>"' }) } as unknown as ShootsService,
    {
      get: (id: string) => {
        if (id === 'broken01') throw new Error('database is locked');
        return { name: 'Best of $& $$' };
      },
    } as unknown as AlbumsService,
    {
      get: (id: string) => (id === photo.id ? photo : notFound()),
      listByLibrary: (_: string, query: PhotoListQuery) => {
        asked.push(query);
        return listing([{ id: 'newest01', tile_built_at: null }], 1234);
      },
      listByShoot: () => listing([{ id: 'newest02', tile_built_at: '2026-03-04T00:00:00.000Z' }], 1),
      listByAlbum: () => listing([], 0),
    } as unknown as PhotoReadService,
  );
  const app = new Hono();
  app.get(route(PathSegment.any()), (c) => c.html(openGraph.inject(SHELL, c)));
  return { app, asked };
}

async function head(path: string, headers: Record<string, string> = {}): Promise<string> {
  const { app } = serving();
  return (await app.request(`http://photos.example${path}`, { headers })).text();
}

describe('OpenGraph', () => {
  it('describes a photo by its file, capture and exposure', async () => {
    expect(await head(route(PathSegment.photos(), 'photo001'))).toBe(
      [
        '<html><head><title>DSC_0001.NEF - Bowerbird</title>',
        '<meta property="og:site_name" content="Bowerbird" />',
        '<meta property="og:type" content="website" />',
        '<meta property="og:title" content="DSC_0001.NEF" />',
        '<meta property="og:url" content="http://photos.example/photos/photo001" />',
        '<meta property="og:description" content="2025-12-31 · NIKON Z 8 · NIKKOR Z 50mm f/1.8 S · 50mm f/1.8 1/250s ISO 100" />',
        '<meta name="description" content="2025-12-31 · NIKON Z 8 · NIKKOR Z 50mm f/1.8 S · 50mm f/1.8 1/250s ISO 100" />',
        `<meta property="og:image" content="http://photos.example/image/photo001/preview?v=${Date.parse('2026-01-02T00:00:00.000Z')}" />`,
        '<meta name="twitter:card" content="summary_large_image" /></head><body></body></html>',
      ].join(''),
    );
  });

  it('describes the photo, not the collection, when one is open inside a shoot', async () => {
    const html = await head(`${route(PathSegment.shoots(), 'shoot001')}${route(PathSegment.photos(), 'photo001')}`);
    expect(html).toContain('<meta property="og:title" content="DSC_0001.NEF" />');
  });

  it("gives a library its newest photo and its size, asking for the newest that isn't rejected", async () => {
    const { app, asked } = serving();
    const html = await (await app.request(`http://photos.example${route(PathSegment.libraries(), 'lib00001', PathSegment.bin())}`)).text();
    expect(html).toContain('<meta property="og:title" content="Everything" />');
    expect(html).toContain('<meta property="og:description" content="1,234 photos" />');
    expect(html).toContain('<meta property="og:image" content="http://photos.example/image/newest01/preview" />');
    expect(asked).toMatchObject([{ ordering: 'taken_desc', limit: 1, triage: ['untriaged', 'picked'] }]);
  });

  it('escapes a collection name', async () => {
    const html = await head(route(PathSegment.shoots(), 'shoot001'));
    expect(html).toContain('<title>Trip "&lt;2025&gt;" - Bowerbird</title>');
    expect(html).toContain('<meta property="og:title" content="Trip &quot;&lt;2025&gt;&quot;" />');
    expect(html).toContain('<meta property="og:description" content="1 photo" />');
  });

  it('leaves out the image for an empty album', async () => {
    const html = await head(route(PathSegment.albums(), 'album001'));
    expect(html).toContain('<title>Best of $&amp; $$ - Bowerbird</title>');
    expect(html).not.toContain('og:image');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
  });

  it('names the address the reader used behind a proxy', async () => {
    const html = await head(route(PathSegment.photos(), 'photo001'), {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'bowerbird.example',
    });
    expect(html).toContain('content="https://bowerbird.example/image/photo001/preview');
  });

  it('serves the shell untouched for a page with nothing to describe', async () => {
    expect(await head(route(PathSegment.settings()))).toBe(SHELL);
    expect(await head(route(PathSegment.photos(), 'missing1'))).toBe(SHELL);
    expect(await head(route(PathSegment.libraries(), 'missing1'))).toBe(SHELL);
  });

  it('still serves the shell when describing the page fails', async () => {
    expect(await head(route(PathSegment.albums(), 'broken01'))).toBe(SHELL);
  });
});

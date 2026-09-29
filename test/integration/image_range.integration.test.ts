// DESIGN §13.5 requires Content-Length from file stats and Range/206 partial
// content so clients can seek in large originals. These go over a real socket
// to check the headers and bytes the browser receives.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../src/errors';
import { applyErrorHandler } from '../../src/api/error_handler';
import { ImageApi } from '../../src/api/image/image_api';
import { localOriginals } from '../../src/services/blobs/originals_for_testing';
import type { Library } from '../../src/schemas/libraries';
import { fileRecipe } from '../../src/schemas/recipes';
import type { BasicPhoto } from '../../src/services/photos/paths/photo_paths_repository';
import type { PhotoRenditionService } from '../../src/services/photos/renditions/photo_rendition_service';
import { dataPathForLibraryId } from '../../src/utils/paths';

const BODY = '0123456789ABCDEF'; // 16 bytes, so byte offsets are readable
// Its own id, because the data directory is keyed by one now (§6).
const LIB = 'image-range';

let root: string;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-range-'));
  const grid = path.join(dataPathForLibraryId(LIB), 'renditions', 'grid');
  mkdirSync(grid, { recursive: true });
  writeFileSync(path.join(grid, 'p1.avif'), BODY);
  writeFileSync(path.join(root, 'a.arw'), BODY);

  const library: Library = {
    id: LIB,
    root_path: root,
    bin_name: 'Bin',
    read_only: false,
    name: 'lib',
    ordering: 'taken_desc',
    rendition_source: 'render',
    rendition_hdr: false,
    render_skip_full: [],
    render_skip_max: [],
    denoiser: 'galosh',
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 1,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 0,
  };
  const basic: BasicPhoto = {
    id: 'p1',
    library_id: LIB,
    shoot_id: null,
    recipe: fileRecipe('a.arw'),
  };
  // `locate`, not `get`: serving bytes wants three columns, not the detail payload
  // and a stat per rendition (§8.2).
  const photos = {
    locate(id: string): { photo: BasicPhoto; library: Library } {
      if (id !== 'p1') throw new AppError('NOT_FOUND', `photo not found: ${id}`);
      return { photo: basic, library };
    },
    // Serving one queues a rebuild where the copy is behind its edits; nothing here asserts on it.
    rebuildIfStale(): void {},
  } as unknown as PhotoRenditionService;

  const app = new Hono();
  app.route(
    '/image',
    new ImageApi(
      {} as ConstructorParameters<typeof ImageApi>[0],
      photos,
      null,
      localOriginals(),
      {} as ConstructorParameters<typeof ImageApi>[4],
    ).routes,
  );
  applyErrorHandler(app);

  server = Bun.serve({ port: 0, fetch: app.fetch });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
});

test('a full rendition response carries Content-Length and advertises range support', async () => {
  const res = await fetch(`${origin}/image/p1/renditions/grid`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-length')).toBe(String(BODY.length));
  expect(res.headers.get('accept-ranges')).toBe('bytes');
  expect(await res.text()).toBe(BODY);
});

test('a ranged request on the original returns 206 with just that slice', async () => {
  const res = await fetch(`${origin}/image/p1/download/original`, {
    headers: { Range: 'bytes=4-7' },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe(`bytes 4-7/${BODY.length}`);
  expect(res.headers.get('content-length')).toBe('4');
  expect(await res.text()).toBe('4567');
});

test('an open-ended range serves through to the end of the file', async () => {
  const res = await fetch(`${origin}/image/p1/download/original`, {
    headers: { Range: 'bytes=12-' },
  });
  expect(res.status).toBe(206);
  expect(await res.text()).toBe('CDEF');
});

test('an unsatisfiable range is rejected rather than served as a full body', async () => {
  const res = await fetch(`${origin}/image/p1/download/original`, {
    headers: { Range: 'bytes=99-200' },
  });
  expect(res.status).toBe(416);
  expect(res.headers.get('content-range')).toBe(`bytes */${BODY.length}`);
  expect(res.headers.get('content-length')).toBe('0');
  expect(await res.text()).toBe('');
});

test.each(['bytes=4-7', 'bytes=12-', 'bytes=99-200'])(
  'a HEAD original ignores range %s and describes the whole file',
  async (range) => {
    const response = await fetch(`${origin}/image/p1/download/original`, {
      method: 'HEAD',
      headers: { Range: range },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('content-length')).toBe(String(BODY.length));
    expect(await response.text()).toBe('');
  },
);

test.each([
  ['bytes=-4', 'CDEF', 'bytes 12-15/16'],
  ['bytes=-99', BODY, 'bytes 0-15/16'],
  ['bytes=4-99', '456789ABCDEF', 'bytes 4-15/16'],
  ['bytes = 4-7', '4567', 'bytes 4-7/16'],
])('an original download preserves range %s', async (range, expected, contentRange) => {
  const response = await fetch(`${origin}/image/p1/download/original`, {
    headers: { Range: range },
  });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(contentRange);
  expect(response.headers.get('content-length')).toBe(String(expected.length));
  expect(await response.text()).toBe(expected);
});

test.each(['bytes=5-3', 'bytes=foo', 'items=1-2', 'bytes=0-1,3-4'])(
  'an original download ignores invalid or multiple range %s',
  async (range) => {
    const response = await fetch(`${origin}/image/p1/download/original`, {
      headers: { Range: range },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('content-length')).toBe(String(BODY.length));
    expect(await response.text()).toBe(BODY);
  },
);

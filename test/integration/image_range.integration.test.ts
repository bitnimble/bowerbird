// DESIGN §13.5 requires Content-Length from file stats and Range/206 partial
// content so clients can seek in large originals. Range is applied by Bun.serve
// to a BunFile body, NOT by Hono's app.request() shim, so these must go over a
// real socket to mean anything.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../src/errors';
import { applyErrorHandler } from '../../src/api/error_handler';
import { ImageApi } from '../../src/api/image/image_api';
import type { Library } from '../../src/schemas/libraries';
import type { BasicPhoto } from '../../src/services/photos/photos_repository';
import type { PhotosService } from '../../src/services/photos/photos_service';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { DEFAULT_SETTINGS } from '../../src/schemas/settings';
import { dataPathForLibraryId } from '../../src/utils/paths';

// Only `get` is reached from these routes, and only by the editor's open.
const settingsForTest = () => ({ get: () => DEFAULT_SETTINGS }) as unknown as SettingsRepository;

const BODY = '0123456789ABCDEF'; // 16 bytes, so byte offsets are readable
// Its own id, because the data directory is keyed by one now (§3).
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
    include_subfolders: true,
    mirror_shoots: true,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 1,
  };
  const basic: BasicPhoto = { id: 'p1', library_id: LIB, file_path: 'a.arw', shoot_id: null };
  // `locate`, not `get`: serving bytes wants three columns, not the detail payload
  // and a stat per rendition (§8.2).
  const photos = {
    locate(id: string): { photo: BasicPhoto; library: Library } {
      if (id !== 'p1') throw new AppError('NOT_FOUND', `photo not found: ${id}`);
      return { photo: basic, library };
    },
  } as unknown as PhotosService;

  const app = new Hono();
  app.route('/image', new ImageApi(photos, settingsForTest()).routes);
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
  const res = await fetch(`${origin}/image/p1/download/original`, { headers: { Range: 'bytes=4-7' } });
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe(`bytes 4-7/${BODY.length}`);
  expect(res.headers.get('content-length')).toBe('4');
  expect(await res.text()).toBe('4567');
});

test('an open-ended range serves through to the end of the file', async () => {
  const res = await fetch(`${origin}/image/p1/download/original`, { headers: { Range: 'bytes=12-' } });
  expect(res.status).toBe(206);
  expect(await res.text()).toBe('CDEF');
});

test('an unsatisfiable range is rejected rather than served as a full body', async () => {
  const res = await fetch(`${origin}/image/p1/download/original`, { headers: { Range: 'bytes=99-200' } });
  expect(res.status).toBe(416);
});

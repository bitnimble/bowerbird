// The loupe's tile route, and specifically what it does with the frame's noise fit: the editor
// measured it at the open and hands it back per tile, because a crop's own fit is between half and
// half again the photograph's and the loupe exists to predict the export.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../src/errors';
import { applyErrorHandler } from '../../src/api/error_handler';
import { ImageApi } from '../../src/api/image/image_api';
import type { Library } from '../../src/schemas/libraries';
import type { BasicPhoto } from '../../src/services/photos/photos_repository';
import type { PhotosService } from '../../src/services/photos/photos_service';
import type { JobLevels, NoiseFit } from '../../src/services/processing/rawshim_job';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { DEFAULT_SETTINGS } from '../../src/schemas/settings';
import { dataPathForLibraryId } from '../../src/utils/paths';

const settingsForTest = () => ({ get: () => DEFAULT_SETTINGS }) as unknown as SettingsRepository;

const LIB = 'image-tile';
const RECT = 'left=100&top=200&width=256&height=256';

let root: string;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let asked: NoiseFit | undefined;
let askedLevels: JobLevels | undefined;
let askedPeak: number | undefined;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-tile-'));
  writeFileSync(path.join(root, 'a.arw'), 'not a RAW, and never decoded: the renderer is a stub');

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
  const photos = {
    locate(id: string): { photo: BasicPhoto; library: Library } {
      if (id !== 'p1') throw new AppError('NOT_FOUND', `photo not found: ${id}`);
      return { photo: basic, library };
    },
  } as unknown as PhotosService;

  const app = new Hono();
  app.route(
    '/image',
    new ImageApi(photos, settingsForTest(), {
      renderTile: (_raw, _photoId, _library, _tile, noiseFit, levels, scenePeak) => {
        asked = noiseFit;
        askedLevels = levels;
        askedPeak = scenePeak;
        return new Uint8Array([1, 2, 3]);
      },
    }).routes,
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

test('a tile carries the frame fit the editor measured', async () => {
  const noise = '0.00015,0.0000011,1.1928239,0.25,0.26,0.27,0.28';
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&noise=${noise}`);
  expect(res.status).toBe(200);
  expect(asked).toEqual({
    alpha: 0.00015,
    sigmaSq: 0.0000011,
    unifiedSigma: 1.1928239,
    darkRef: [0.25, 0.26, 0.27, 0.28],
  });
});

// A real frame's numbers rather than round ones, because the parameter is a decimal string and an
// f32 that survives `0.0001502` will survive anything the fit produces.
test('a fit crosses the parameter unchanged', async () => {
  const fit: NoiseFit = {
    alpha: 0.0001502,
    sigmaSq: 0.0000011,
    unifiedSigma: 1.1928239,
    darkRef: [0.1, -0.02, 0.33, 0.4],
  };
  const noise = [fit.alpha, fit.sigmaSq, fit.unifiedSigma, ...fit.darkRef].join(',');
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&noise=${noise}`);
  expect(res.status).toBe(200);
  expect(asked).toEqual(fit);
});

test('a tile without one is rendered anyway, fitting its own', async () => {
  asked = { alpha: 1, sigmaSq: 1, unifiedSigma: 1, darkRef: [1, 1, 1, 1] };
  const res = await fetch(`${origin}/image/p1/tile?${RECT}`);
  expect(res.status).toBe(200);
  expect(asked).toBeUndefined();
});

// Dropped rather than refused: the fit is an optimisation of an answer the renderer can reach on
// its own, so a client that garbles it gets a tile rather than an error.
test.each([
  ['too few numbers', '0.1,0.2,0.3'],
  ['too many', '0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8'],
  ['not numbers', 'a,b,c,d,e,f,g'],
  ['empty', ''],
])('a %s noise parameter is ignored', async (_name, noise) => {
  asked = { alpha: 1, sigmaSq: 1, unifiedSigma: 1, darkRef: [1, 1, 1, 1] };
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&noise=${noise}`);
  expect(res.status).toBe(200);
  expect(asked).toBeUndefined();
});

// The frame's diffuse white and scene peak, which the crop cannot measure for itself: the base is
// coded by dividing by white, so a tile that reads its own lifts a dark part of a photograph
// towards reference white and rolls its highlights into a peak barely above it.
test('a tile carries the levels the editor measured', async () => {
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&levels=8133.5,13783`);
  expect(res.status).toBe(200);
  expect(askedLevels).toEqual({ white: 8133.5, peak: 13783 });
});

test.each([
  ['too few numbers', '8133'],
  ['too many', '8133,13783,1'],
  ['not numbers', 'white,peak'],
  ['empty', ''],
])('a %s levels parameter is ignored', async (_name, levels) => {
  askedLevels = { white: 1, peak: 1 };
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&levels=${levels}`);
  expect(res.status).toBe(200);
  expect(askedLevels).toBeUndefined();
});

// The third whole-frame quantity, and the one that moves with the reader's sliders: what the
// highlight roll-off compresses into the display, measured by the editor's own tick.
test('a tile carries the scene peak the tick measured', async () => {
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&scenePeak=4130.5`);
  expect(res.status).toBe(200);
  expect(askedPeak).toBe(4130.5);
});

test.each([
  ['zero', '0'],
  ['negative', '-1'],
  ['not a number', 'bright'],
  ['empty', ''],
])('a %s scene peak is ignored', async (_name, peak) => {
  askedPeak = 1;
  const res = await fetch(`${origin}/image/p1/tile?${RECT}&scenePeak=${peak}`);
  expect(res.status).toBe(200);
  expect(askedPeak).toBeUndefined();
});

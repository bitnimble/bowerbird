// The full-resolution export is a second decode path feeding an encoder that
// lives outside libvips for the HDR case. None of that is visible until someone
// opens the file (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../src/schemas/libraries';
import { DEFAULT_SETTINGS, type Settings } from '../../src/schemas/settings';
import { ProcessingService } from '../../src/services/processing/processing_service';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { readRawHeader } from '../../src/services/processing/raw_decoder';
import { decodeImage, freeImage } from '../../src/services/processing/rawshim_ops';
import { decodeRaw, pixels } from '../../src/services/processing/rawshim_pixels';
import { getRenditionPath } from '../../src/utils/paths';

// The output path is the library's business now, so the test asks for it the
// same way the server does rather than naming a file of its own.
function library(dataPath: string, hdr: boolean): Library {
  return {
    id: 'lib',
    root_path: dataPath,
    data_path: dataPath,
    name: null,
    ordering: 'added_desc',
    rendition_source: 'render',
    rendition_hdr: hdr,
    rendition_hdr_video: false,
    include_subfolders: true,
    mirror_shoots: true,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 0,
  };
}

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

// A one-off render stamps the row it wrote and announces it (§18.6), so the
// service needs a repository even here, where the subject is the pixels.
const stamps = { markTileBuilt: () => {}, markRenditionsBuilt: () => {} } as never;

function service(): ProcessingService {
  // Matching off: the assertion below is against a plain `decodeRaw`, and the
  // camera's own colour treatment is exactly what would make the two differ.
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 1, match_embedded_jpeg: false };
  return new ProcessingService(stamps, { get: () => settings } as SettingsRepository);
}

test('a 16-bit decode yields twice the bytes of an 8-bit one', () => {
  // Half size: the subject is the sample width, and the two decodes have to agree
  // about the frame, not fill it.
  const half = { atLeastLongEdge: 1000 };
  const eight = decodeRaw(FIXTURE, 8, 'srgb', half);
  const sixteen = decodeRaw(FIXTURE, 16, 'srgb', half);

  expect(eight.depth).toBe(8);
  expect(sixteen.depth).toBe(16);
  // Same picture, same crop: only the sample size differs.
  expect(sixteen.width).toBe(eight.width);
  expect(sixteen.height).toBe(eight.height);
  expect(sixteen.data.length).toBe(eight.data.length * 2);
});

// Goes through the real worker, not a copy of its logic: an earlier bug here
// wrote a file of exactly the right dimensions whose pixels were the 16-bit
// buffer misread as 8-bit, which only the shipped path can catch.
test('the SDR render the service produces decodes back to the image that went in', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-lossless-'));
  const lib = library(dir, false);
  const output = getRenditionPath(lib, 'test-photo', 'max', false);
  try {
    await service().renderOne(FIXTURE, 'test-photo', lib, 'max', false);

    const expected = decodeRaw(FIXTURE, 8);
    const written = decodeImage(Buffer.from(await Bun.file(output).arrayBuffer()));
    // Full resolution: this is the view that gets pixel-peeped, so unlike every
    // other rendition it is never fitted to a maximum edge.
    expect(written.width).toBe(expected.width);
    expect(written.height).toBe(expected.height);
    // Comfortably inside the size budget the quality was chosen against.
    expect(statSync(output).size).toBeLessThan(20_000_000);

    // The pixels, not just the dimensions. A wrong-depth read produces a file of
    // exactly the right size full of garbage, which only a comparison catches.
    const actual = pixels(written);
    freeImage(written);
    let sum = 0;
    for (let i = 0; i < actual.length; i++) sum += (actual[i]! - expected.data[i]!) ** 2;
    const psnr = 10 * Math.log10(255 ** 2 / (sum / actual.length));
    // Sensor noise is what a lossy encoder discards first, so PSNR runs low on
    // RAW-derived pixels even when the result is perceptually identical. The
    // bound is set to catch a wrong-pixels bug, which lands far below this.
    expect(psnr).toBeGreaterThan(30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('the HDR render is 10-bit PQ at full resolution', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-lossless-hdr-'));
  const lib = library(dir, true);
  const output = getRenditionPath(lib, 'test-photo', 'max', true);
  try {
    await service().renderOne(FIXTURE, 'test-photo', lib, 'max', true);

    const proc = Bun.spawnSync([
      'ffprobe', '-hide_banner', '-loglevel', 'error',
      '-show_entries', 'stream=width,height,pix_fmt,color_transfer,color_primaries',
      '-of', 'default=noprint_wrappers=1', output,
    ]);
    const info = proc.stdout.toString();
    // The header's dimensions, not a decode's: raw_header pins that the two agree.
    const expected = readRawHeader(FIXTURE);

    // The shipped default rather than an invariant: `hdr_still_full_chroma` turns
    // this into 4:4:4, and the argv pin covers both. What matters here is the depth
    // and the transfer, which no setting moves.
    expect(info).toContain('pix_fmt=yuv420p10le');
    expect(info).toContain('color_transfer=smpte2084');
    expect(info).toContain('color_primaries=bt2020');
    // Not fitted, unlike the HDR check renditions (§10.7).
    expect(info).toContain(`width=${expected.width}`);
    expect(info).toContain(`height=${expected.height}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

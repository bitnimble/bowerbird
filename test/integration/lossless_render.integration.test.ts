// The full-resolution export is a second decode path feeding an encoder that
// lives outside sharp for the HDR case. None of that is visible until someone
// opens the file (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { Library } from '../../src/schemas/libraries';
import { ProcessingService } from '../../src/services/processing/processing_service';
import { decodeRaw } from '../../src/services/processing/raw_decoder';
import { getRenditionPath } from '../../src/utils/paths';

// The output path is the library's business now, so the test asks for it the
// same way the server does rather than naming a file of its own.
function library(dataPath: string, hdr: boolean): Library {
  return {
    id: 'lib',
    root_path: dataPath,
    data_path: dataPath,
    ordering: 'added_desc',
    preview_source: 'render',
    preview_hdr: hdr,
    preview_hdr_video: false,
    last_synced_at: null,
    photo_count: 0,
  };
}

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

function service(): ProcessingService {
  return new ProcessingService({} as never, {
    processingConcurrency: 1,
    losslessQuality: 88,
    losslessQuantizer: 8,
    hdrPeakNits: 1000,
    hdrPreset: 8,
  } as never);
}

test('a 16-bit decode yields twice the bytes of an 8-bit one', () => {
  const eight = decodeRaw(FIXTURE, 8);
  const sixteen = decodeRaw(FIXTURE, 16);

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
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('heif'); // libvips reports AVIF as its container
    // Full resolution: this is the view that gets pixel-peeped, so unlike every
    // other rendition it is never fitted to a maximum edge.
    expect(meta.width).toBe(expected.width);
    expect(meta.height).toBe(expected.height);
    // Comfortably inside the size budget the quality was chosen against.
    expect(statSync(output).size).toBeLessThan(20_000_000);

    // The pixels, not just the dimensions. A wrong-depth read produces a file of
    // exactly the right size full of garbage, which only a comparison catches.
    const actual = await sharp(output).raw().toBuffer();
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
    const expected = decodeRaw(FIXTURE, 8);

    expect(info).toContain('pix_fmt=yuv444p10le');
    expect(info).toContain('color_transfer=smpte2084');
    expect(info).toContain('color_primaries=bt2020');
    // Not fitted, unlike the HDR check renditions (§10.7).
    expect(info).toContain(`width=${expected.width}`);
    expect(info).toContain(`height=${expected.height}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

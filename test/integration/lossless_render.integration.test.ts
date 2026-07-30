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
import { comparePsnr, decodeSummary } from '../../src/services/processing/rawshim_debug';
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
  // The whole frame at both depths, which costs two full decodes and is the only
  // way to get the same one twice. `atLeastLongEdge` is not the same instruction
  // at both depths any more: the scene-linear path fits the frame to it on the way
  // out of LibRaw (§10.4), where the 8-bit path uses it only to decide whether to
  // halve. So asking both for 1000 returned 668x1000 and 2012x3012 - a real
  // difference, correctly reported, that this test is not about.
  const whole = { atLeastLongEdge: 0 } as const;
  const eight = decodeSummary(FIXTURE, { depth: 8, space: 'srgb', ...whole });
  const sixteen = decodeSummary(FIXTURE, { depth: 16, space: 'srgb', ...whole });

  expect(eight.depth).toBe(8);
  expect(sixteen.depth).toBe(16);
  // Same picture, same crop: only the sample size differs.
  expect(sixteen.width).toBe(eight.width);
  expect(sixteen.height).toBe(eight.height);
  // Same count of samples, twice the bytes - which is the whole claim, and says it
  // more directly than comparing two buffer lengths did.
  expect(sixteen.samples).toBe(eight.samples);
  expect(sixteen.bytes).toBe(eight.bytes * 2);
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

    // The pixels, not just the dimensions. A wrong-depth read produces a file of
    // exactly the right size full of garbage, which only a comparison catches - so
    // the comparison is made where both images already are, and what comes back is
    // the number this was going to reduce them to.
    const expected = decodeSummary(FIXTURE, { depth: 8 });
    const written = comparePsnr(output, FIXTURE);
    // Full resolution: this is the view that gets pixel-peeped, so unlike every
    // other rendition it is never fitted to a maximum edge.
    expect(written.width).toBe(expected.width);
    expect(written.height).toBe(expected.height);
    // Comfortably inside the size budget the quality was chosen against.
    expect(statSync(output).size).toBeLessThan(20_000_000);

    // 8-bit 4:2:0, which is what `sdr_full_chroma` defaults to. Pinned because
    // nothing else on the SDR path looks at the pixel format, and a rendition that
    // quietly changed chroma would still decode, still be the right size, and still
    // pass every other assertion in this file.
    const probe = Bun.spawnSync([
      'ffprobe', '-hide_banner', '-loglevel', 'error',
      '-show_entries', 'stream=pix_fmt', '-of', 'default=noprint_wrappers=1', output,
    ]);
    expect(probe.stdout.toString()).toContain('pix_fmt=yuv420p');

    // Sensor noise is what a lossy encoder discards first, so PSNR runs low on
    // RAW-derived pixels even when the result is perceptually identical. The
    // bound is set to catch a wrong-pixels bug, which lands far below this.
    expect(written.psnr).not.toBeNull();
    expect(written.psnr!).toBeGreaterThan(30);
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

// The full-resolution export is a second decode path, feeding a different encoder
// again for the HDR case. None of that is visible until someone opens the file
// (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { rmSync, statSync } from 'node:fs';
import type { Library } from '../../src/schemas/libraries';
import { DEFAULT_SETTINGS, type Settings } from '../../src/schemas/settings';
import { ProcessingService } from '../../src/services/processing/processing_service';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { readRawHeader } from '../../src/services/processing/raw_decoder';
import { _for_testing_decodeSummary, _for_testing_deltaEToPreview } from '../../src/services/processing/rawshim_for_testing';
import { getDataPath, getRenditionPath } from '../../src/utils/paths';

// The output path is the library's business now, so the test asks for it the
// same way the server does rather than naming a file of its own. The id is what
// that path is keyed by (§6), so each test needs its own or two files that clean
// up after themselves share a directory.
function library(id: string, hdr: boolean): Library {
  return {
    id,
    root_path: '/does-not-matter',
    bin_name: 'Bin',
    read_only: false,
    name: 'lib',
    ordering: 'added_desc',
    rendition_source: 'render',
    rendition_hdr: hdr,
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

// Matching on, because the camera's own JPEG is the only oracle a render has. There is
// one rendering pipeline now and SDR is its output stage, so an SDR rendition is a
// scene-referred grade - diffuse white at the BT.2408 anchor, highlights rolled off by
// BT.2390 - rather than LibRaw's 8-bit output with its own auto-brightness. Held against
// a plain `decodeRaw` the two differ by a whole tone curve, which says nothing about
// whether the pixels are right.
function service(): ProcessingService {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 1, match_embedded_jpeg: true };
  return new ProcessingService(stamps, { get: () => settings } as SettingsRepository);
}

test('a 16-bit decode yields twice the bytes of an 8-bit one', () => {
  // The whole frame at both depths, which costs two full decodes and is the only
  // way to get the same one twice. `atLeastLongEdge` is not the same instruction
  // at both depths: the scene-linear path fits the frame to it on the way out
  // (§10.4), where the 8-bit path uses it only to decide whether to halve. So
  // asking both for 1000 returned 668x1000 and 2012x3012 - a real difference,
  // correctly reported, that this test is not about.
  //
  // **Each depth in the space that depth is served in.** There are two decodes and
  // only two: scene-linear Rec.2020 at 16 bits, and sRGB at 8. Sixteen-bit sRGB was
  // LibRaw handing back whatever `dcraw_process` was asked for; the decode declines
  // it now, so pairing the depths differently is asking for a frame that does not
  // exist rather than testing one.
  const whole = { atLeastLongEdge: 0 } as const;
  const eight = _for_testing_decodeSummary(FIXTURE, { depth: 8, space: 'srgb', ...whole });
  const sixteen = _for_testing_decodeSummary(FIXTURE, { depth: 16, space: 'rec2020-linear', ...whole });

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
  const lib = library('lossless-sdr', false);
  const dir = getDataPath(lib);
  const output = getRenditionPath(lib, 'test-photo', 'max', false);
  try {
    await service().renderOne(FIXTURE, 'test-photo', lib, 'max', false);

    // The pixels, not just the dimensions. A wrong-depth read produces a file of
    // exactly the right size full of garbage, which only a comparison catches - so
    // the comparison is made where both images already are, and what comes back is
    // the number this was going to reduce them to.
    const expected = _for_testing_decodeSummary(FIXTURE, { depth: 8 });
    const against = _for_testing_deltaEToPreview([output], FIXTURE);
    // Full resolution: this is the view that gets pixel-peeped, so unlike every
    // other rendition it is never fitted to a maximum edge.
    const [width, height] = against.sizes[0]!;
    expect(width).toBe(expected.width);
    expect(height).toBe(expected.height);
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

    // Against the camera's own JPEG, which is what the fit is trying to reproduce
    // (DESIGN 10.8.1) and the only claim about these pixels that survives the grade.
    // Measured at 1.02 on this fixture and 2.12 on the Canon one; the same render with
    // the match declined lands at 31, and garbage is an order past that - so the bound
    // catches a wrong-pixels bug and a match that never reached the encoder both.
    expect(against.meanDeltaE[0]!).toBeLessThan(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('the HDR render is 10-bit PQ at full resolution', async () => {
  const lib = library('lossless-hdr', true);
  const dir = getDataPath(lib);
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

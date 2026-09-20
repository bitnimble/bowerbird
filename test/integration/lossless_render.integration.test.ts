// The full-resolution export is a second decode path, feeding a different encoder
// again for the HDR case. None of that is visible until someone opens the file
// (§10.5).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { rmSync, statSync } from 'node:fs';
import type { Library } from '../../src/schemas/libraries';
import { DEFAULT_SETTINGS, type Settings } from '../../src/schemas/settings';
import { ProcessingService } from '../../src/services/processing/pipeline/processing_service';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { readRawHeader } from '../../src/services/processing/rawshim/raw_decoder';
import { _for_testing_decodeSummary, _for_testing_deltaEToPreview } from '../../src/services/processing/rawshim/rawshim_for_testing';
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
    include_non_raw: false,
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
const stamps = { markTileBuilt: () => {}, markRenditionsBuilt: () => {}, markCopyBuilt: () => {} } as never;

// Matching on, because the camera's own JPEG is the only oracle a render has. There is
// one rendering pipeline now and SDR is its output stage, so an SDR rendition is a
// scene-referred grade - diffuse white at the BT.2408 anchor, highlights rolled off by
// BT.2390 - rather than LibRaw's 8-bit output with its own auto-brightness. Held against
// a plain `decodeRaw` the two differ by a whole tone curve, which says nothing about
// whether the pixels are right.
function service(): ProcessingService {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 1, match_embedded_jpeg: true };
  return new ProcessingService(
    stamps,
    {} as ConstructorParameters<typeof ProcessingService>[1],
    {} as ConstructorParameters<typeof ProcessingService>[2],
    { get: () => settings } as SettingsRepository,
  );
}

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
    const expected = _for_testing_decodeSummary(FIXTURE);
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
    // (DESIGN 10.8.1) and the only claim about these pixels that survives the grade. A
    // matched render sits low single digits of CIEDE2000 from it, a render whose match
    // declined an order above that, and garbage another order past - so the bound catches
    // a wrong-pixels bug and a match that never reached the encoder both.
    expect(against.meanDeltaE[0]!).toBeLessThan(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('the HDR render is 12-bit PQ at full resolution', async () => {
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

    // The shipped default rather than an invariant: `hdr_still_full_chroma` turns this into
    // 4:4:4, and `avif_still` covers both. What matters here is the depth and the transfer,
    // which no setting moves.
    expect(info).toContain('pix_fmt=yuv420p12le');
    expect(info).toContain('color_transfer=smpte2084');
    expect(info).toContain('color_primaries=bt2020');
    // Not fitted, unlike the HDR check renditions (§10.7).
    expect(info).toContain(`width=${expected.width}`);
    expect(info).toContain(`height=${expected.height}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

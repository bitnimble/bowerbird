// What a share hands to another application: the rendition on screen, as a JPEG carrying the
// range in a gain map beside it (§10.5). The whole chain is only reachable from here - a render
// of a real frame, that file read back as a picture and rolled to SDR, and libavif's map
// computed between the two - and every part of it is somewhere a size or a transfer can be lost.
//   docker exec bowerbird-dev bun test test/integration/share_gain_map
import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Library } from '../../src/schemas/libraries';
import { DEFAULT_SETTINGS, type Settings } from '../../src/schemas/settings';
import { ExportService } from '../../src/services/processing/exports/export_service';
import { ProcessingService } from '../../src/services/processing/pipeline/processing_service';
import { _for_testing_deltaEToPreview } from '../../src/services/processing/rawshim/rawshim_for_testing';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { getDataPath, getRenditionPath } from '../../src/utils/paths';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const PHOTO = 'test-photo';

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
    render_skip_full: [],
    render_skip_max: [],
    render_timings: {},
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 0,
  };
}

const stamps = { markTileBuilt: () => {}, markRenditionsBuilt: () => {}, markCopyBuilt: () => {} } as never;

// No camera match: it is a second of fitting that every picture here pays equally, and every
// claim below is one render against another rather than either against an absolute.
function processing(): ProcessingService {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 1, match_embedded_jpeg: false };
  return new ProcessingService(
    stamps,
    {} as ConstructorParameters<typeof ProcessingService>[1],
    {} as ConstructorParameters<typeof ProcessingService>[2],
    { get: () => settings } as SettingsRepository,
  );
}

// `full` rather than `max`: a share is the picture the viewer is showing, and this is the size
// most libraries show it at - a 60MP roll and two encodes of it is a minute nobody learns
// anything from.
async function shared(lib: Library): Promise<{ rendition: string; jpeg: Uint8Array }> {
  const service = processing();
  const rendition = getRenditionPath(lib, PHOTO, 'full', lib.rendition_hdr);
  await service.renderOne(FIXTURE, PHOTO, lib, 'full', lib.rendition_hdr);
  const jpeg = await new ExportService({} as never, service).shareable(PHOTO, rendition, lib.rendition_hdr);
  return { rendition, jpeg };
}

function sizeOf(file: string): string {
  const probe = Bun.spawnSync([
    'ffprobe', '-hide_banner', '-loglevel', 'error',
    '-show_entries', 'stream=width,height', '-of', 'default=noprint_wrappers=1', file,
  ]);
  return probe.stdout.toString().trim();
}

function has(jpeg: Uint8Array, marker: string): boolean {
  return Buffer.from(jpeg).includes(Buffer.from(marker, 'binary'));
}

// The picture on its own: everything from the primary image's `EOI` on is the map and the index
// that names it, which is exactly what a reader that has never heard of either stops before.
function primary(jpeg: Uint8Array): Uint8Array {
  return jpeg.subarray(0, Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xd9])) + 2);
}

test('an HDR rendition is shared as a JPEG with a gain map, at the size it already was', async () => {
  const lib = library('share-hdr', true);
  const data = getDataPath(lib);
  try {
    const { rendition, jpeg } = await shared(lib);

    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    // Both spellings of the terms, which is what `jpeg_gain_write` writes them twice for: ISO
    // 21496-1 for Apple and Android 15, Google's XMP for everything that never moved.
    expect(has(jpeg, 'urn:iso:std:iso:ts:21496:-1')).toBe(true);
    expect(has(jpeg, 'hdrgm:')).toBe(true);
    // The index that binds the map to the picture. Without it the second JPEG is bytes past an
    // `EOI` that no reader goes looking for.
    expect(has(jpeg, 'MPF\0')).toBe(true);

    // **The claim that makes this a re-encode rather than a render**: the base is the rendition
    // rolled down, so it comes back at the rendition's own size. A map is computed between two
    // images of one size or not at all, so a mismatch would already have thrown - which makes
    // this the assertion that says the roll read the file it was handed.
    const out = path.join(data, 'shared.jpg');
    writeFileSync(out, jpeg);
    expect(sizeOf(out)).toBe(sizeOf(rendition));

    // **And that what a reader without gain map support sees is the picture this app would have
    // given them anyway.** The base is the HDR rendition rolled into diffuse white; an SDR
    // rendition is the same grade rolled the same way from the sensor. Held against the camera's
    // own JPEG - the only oracle a render has - the two land on the same number, where a base
    // that had been graded twice, sharpened again or clipped instead of rolled would not.
    const base = path.join(data, 'base.jpg');
    writeFileSync(base, primary(jpeg));
    await processing().renderOne(FIXTURE, PHOTO, lib, 'full', false);
    const [rolled, native] = _for_testing_deltaEToPreview([base, getRenditionPath(lib, PHOTO, 'full', false)], FIXTURE).meanDeltaE;
    expect(Math.abs(rolled! - native!)).toBeLessThan(1);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
}, 300_000);

// An SDR library has no range to carry, so the same press is a transcode and the file has no
// second picture in it.
test('an SDR rendition is shared as an ordinary JPEG', async () => {
  const lib = library('share-sdr', false);
  try {
    const { jpeg } = await shared(lib);

    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    expect(has(jpeg, 'MPF\0')).toBe(false);
  } finally {
    rmSync(getDataPath(lib), { recursive: true, force: true });
  }
}, 300_000);

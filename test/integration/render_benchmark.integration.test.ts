import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPTIONAL_STAGES } from '../../src/schemas/render_stages';
import { DEFAULT_SETTINGS, type Settings } from '../../src/schemas/settings';
import { ProcessingService } from '../../src/services/processing/pipeline/processing_service';
import { readRawHeader } from '../../src/services/processing/rawshim/raw_decoder';
import { RenderTimingsFile } from '../../src/services/processing/renditions/render_timings_file';
import type { PhotoPathsRepository } from '../../src/services/photos/paths/photo_paths_repository';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';

const REFERENCE_FRAME = join(import.meta.dir, '../../assets/reference_frame.ARW');
const TIFF_TYPE_BYTES: Partial<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function tiffValue(file: Buffer, ifd: number, tag: number): Buffer {
  if (ifd < 0 || ifd + 2 > file.length) throw new Error(`TIFF IFD offset ${ifd} is out of bounds`);
  const count = file.readUInt16LE(ifd);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > file.length) throw new Error(`TIFF entry ${index} is out of bounds`);
    if (file.readUInt16LE(entry) !== tag) continue;
    const type = file.readUInt16LE(entry + 2);
    const typeBytes = TIFF_TYPE_BYTES[type];
    if (typeBytes == null) throw new Error(`unsupported TIFF type ${type}`);
    const components = file.readUInt32LE(entry + 4);
    if (components === 0) throw new Error(`TIFF tag 0x${tag.toString(16)} is empty`);
    const bytes = typeBytes * components;
    const offset = bytes <= 4 ? entry + 8 : file.readUInt32LE(entry + 8);
    if (offset + bytes > file.length) throw new Error(`TIFF tag 0x${tag.toString(16)} is out of bounds`);
    return file.subarray(offset, offset + bytes);
  }
  throw new Error(`TIFF tag 0x${tag.toString(16)} is missing`);
}

test('the sanitization reader rejects an unknown TIFF field type', () => {
  const file = Buffer.alloc(14);
  file.writeUInt16LE(1, 0);
  file.writeUInt16LE(0x927c, 2);
  file.writeUInt16LE(13, 4);
  file.writeUInt32LE(1, 6);

  expect(() => tiffValue(file, 0, 0x927c)).toThrow('unsupported TIFF type 13');
});

function service(): ProcessingService {
  const settings: Settings = { ...DEFAULT_SETTINGS, processing_concurrency: 1, match_embedded_jpeg: true };
  return new ProcessingService(
    { markTileBuilt: () => {}, markRenditionsBuilt: () => {}, markCopyBuilt: () => {} } as never,
    {} as PhotoPathsRepository,
    {} as ConstructorParameters<typeof ProcessingService>[2],
    { get: () => settings } as SettingsRepository,
    () => null,
    () => null,
  );
}

function timings(): { file: RenderTimingsFile; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'bowerbird-timings-'));
  return { file: new RenderTimingsFile(join(root, 'render_timings.json')), root };
}

const scratchDirs = (): string[] => readdirSync(tmpdir()).filter((entry) => entry.startsWith('bowerbird-benchmark-'));

test('the sanitized shipped frame prices every optional stage without a library', async () => {
  const raw = readFileSync(REFERENCE_FRAME);
  const exif = tiffValue(raw, raw.readUInt32LE(4), 0x8769).readUInt32LE(0);
  expect(tiffValue(raw, exif, 0x927c).every((byte) => byte === 0)).toBe(true);
  for (const tag of [0x9290, 0x9291, 0x9292]) {
    expect(tiffValue(raw, exif, tag).every((byte) => byte === 0)).toBe(true);
  }
  expect(readRawHeader(REFERENCE_FRAME)).toMatchObject({
    width: 6336,
    height: 9504,
    dateTaken: null,
    latitude: null,
    longitude: null,
    cameraMake: 'Sony',
    cameraModel: 'ILCE-7CR',
  });

  const { file: into, root } = timings();
  const before = scratchDirs();
  // A measurement of another rendition, to prove this one files beside it rather than over it.
  into.put('max', { total: 999, stages: { denoise: 1 }, measured_at: '2026-01-01T00:00:00.000Z' });
  try {
    const timing = await service().benchmarkRender('full', into);

    expect(timing.total).toBeGreaterThan(0);
    // Every stage answers, whether or not it cost anything on this frame: a missing key reads as
    // "not measured" in the panel and falls back to the estimate, which would hide a stage whose
    // gate had stopped working.
    for (const stage of OPTIONAL_STAGES) expect(timing.stages[stage]).toBeGreaterThanOrEqual(0);
    // The camera match is the expensive one everywhere it has been measured, and the arm most
    // likely to go quiet: it is skipped outright when an analysis is on file, so a benchmark that
    // stopped rendering cold would report nothing for it while every other stage still read.
    expect(timing.stages.colour).toBeGreaterThan(0);

    // Filed under the rendition, beside the one that was already there.
    const filed = into.read();
    expect(filed.full?.total).toBe(timing.total);
    expect(filed.max?.total).toBe(999);

    expect(scratchDirs()).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 600_000);

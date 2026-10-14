import { afterAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { LibraryConfiguration } from '../../src/schemas/libraries';
import { SettingsSchema } from '../../src/schemas/settings';
import { RenderTargets } from '../../src/services/processing/pipeline/render_targets';
import { TenBitCopies } from '../../src/services/processing/renditions/ten_bit_copies';
import type { SettingsRepository } from '../../src/services/settings/settings_repository';
import { dataPathForLibraryId, renditionPathFor } from '../../src/utils/paths';

const LIB = 'lib-ten-bit-copies';
const STILL = `${import.meta.dir}/../../web/public/hdr/sun-hdr.avif`;

const settings = { get: () => SettingsSchema.parse({}) } as unknown as SettingsRepository;
const copies = new TenBitCopies(new RenderTargets(settings));
const library = (hdr: boolean): LibraryConfiguration =>
  ({ id: LIB, rendition_hdr: hdr }) as LibraryConfiguration;

const source = renditionPathFor(dataPathForLibraryId(LIB), 'p1', 'full', true);
mkdirSync(path.dirname(source), { recursive: true });
copyFileSync(STILL, source);
afterAll(() => rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true }));

function probe(file: string): { pix_fmt: string; color_transfer: string } {
  const result = Bun.spawnSync([
    'ffprobe',
    '-hide_banner',
    '-loglevel',
    'error',
    '-show_entries',
    'stream=pix_fmt,color_transfer',
    '-of',
    'json',
    file,
  ]);
  if (result.exitCode !== 0) throw new Error(`ffprobe failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString()).streams[0];
}

test('an HDR rendition is served as a 10-bit 4:2:0 PQ copy beside it', async () => {
  const copy = await copies.pathFor(library(true), 'p1', 'full');
  expect(copy).toBe(
    path.join(dataPathForLibraryId(LIB), 'renditions', 'full-hdr-10bit', 'p1.avif'),
  );
  expect(probe(copy)).toEqual({ pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' });
});

test("macOS's copy, white at 100 nits, is kept beside the 203 one", async () => {
  const copy = await copies.pathFor(library(true), 'p1', 'full', 100);
  expect(copy).toBe(
    path.join(dataPathForLibraryId(LIB), 'renditions', 'full-hdr-10bit-white100', 'p1.avif'),
  );
  expect(probe(copy)).toEqual({ pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' });
});

test('the copy is kept until its still changes', async () => {
  const copy = await copies.pathFor(library(true), 'p1', 'full');
  const written = statSync(copy).ino;
  await copies.pathFor(library(true), 'p1', 'full');
  expect(statSync(copy).ino).toBe(written);

  const later = new Date(statSync(source).mtimeMs + 60_000);
  utimesSync(source, later, later);
  await copies.pathFor(library(true), 'p1', 'full');
  expect(statSync(copy).ino).not.toBe(written);
  expect(Math.abs(statSync(copy).mtimeMs - later.getTime())).toBeLessThan(1);
});

test('two readers asking at once share one encode', async () => {
  const later = new Date(statSync(source).mtimeMs + 60_000);
  utimesSync(source, later, later);
  const [first, second] = await Promise.all([
    copies.pathFor(library(true), 'p1', 'full'),
    copies.pathFor(library(true), 'p1', 'full'),
  ]);
  expect(first).toBe(second);
  expect(readdirSync(path.dirname(first))).toEqual(['p1.avif']);
});

test('a rendition with no still is served as its own path, which 404s', async () => {
  expect(await copies.pathFor(library(true), 'absent', 'full')).toBe(
    renditionPathFor(dataPathForLibraryId(LIB), 'absent', 'full', true),
  );
});

test('an SDR rendition is served as itself', async () => {
  expect(await copies.pathFor(library(false), 'p1', 'full')).toBe(
    renditionPathFor(dataPathForLibraryId(LIB), 'p1', 'full', false),
  );
});

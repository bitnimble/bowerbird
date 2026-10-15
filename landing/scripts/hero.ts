// The landing hero, from what `screenshots.spec.ts` captured of the viewer: the shot as AVIF, and
// an HDR version with the photo's own PQ rendition in place of the SDR draw headless Chromium
// captures, the rest of the page at SDR white.
//
//   bun run landing/scripts/hero.ts
//
// Run by the hero capture itself, under bun for the FFI. `ffmpeg` and `avifenc` are needed, as for
// `scripts/demo-assets.ts`, and `bun run build:native` for the 10-bit copy.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { exited, run } from '../../scripts/spawned';
import { SDR_MATCHES, sdrMatchSuffix, type SdrMatch } from '../../src/schemas/sdr_match';
import { SettingsSchema } from '../../src/schemas/settings';
import { encoderQuality } from '../../src/services/processing/analysis/quality';
import { writeTenBitCopy } from '../../src/services/processing/rawshim/rawshim_job';
import { HERO_CAPTURE, SHOTS_DIR } from './shots_state';

const SETTINGS = SettingsSchema.parse({});
const WHITE_NITS = SETTINGS.hdr_reference_white_nits;
const SDR_QUANTIZER = encoderQuality('avif-sdr', SETTINGS.full_rendition_quality);
const HDR_QUANTIZER = encoderQuality('avif-hdr', SETTINGS.full_rendition_quality);
const SPEED = 4;

const SDR_OUT = path.join(SHOTS_DIR, 'viewer.avif');

function hdrOut(matching: SdrMatch): string {
  return path.join(SHOTS_DIR, `viewer-hdr${sdrMatchSuffix(matching)}.avif`);
}

const PlacedSchema = z.object({
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  scale: z.number(),
});
type Placed = z.infer<typeof PlacedSchema>;
type Rect = Placed['box'];

function sizeOf(file: string): { width: number; height: number } {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  const [width, height] = probe.stdout.trim().split('\n')[0]!.split(',').map(Number);
  if (width == null || height == null || !(width > 0 && height > 0))
    throw new Error(`ffprobe could not size ${file}: ${probe.stderr}`);
  return { width, height };
}

function maxCllOf(file: string): number {
  const bytes = readFileSync(file);
  const at = bytes.indexOf('clli');
  if (at < 0) throw new Error(`${file} carries no content light level`);
  return bytes.readUInt16BE(at + 4);
}

/** Where the stage drew the photo, in shot pixels: contained in its box. */
function drawnRect({ box, scale }: Placed, photo: { width: number; height: number }): Rect {
  const fit = Math.min(box.width / photo.width, box.height / photo.height);
  const width = photo.width * fit;
  const height = photo.height * fit;
  const left = (box.x + (box.width - width) / 2) * scale;
  const top = (box.y + (box.height - height) / 2) * scale;
  const x = Math.round(left);
  const y = Math.round(top);
  return {
    x,
    y,
    width: Math.round(left + width * scale) - x,
    height: Math.round(top + height * scale) - y,
  };
}

async function writeSdr(): Promise<void> {
  const quantizer = String(SDR_QUANTIZER);
  await run('avifenc', [
    '--min',
    quantizer,
    '--max',
    quantizer,
    '-s',
    String(SPEED),
    HERO_CAPTURE.shot,
    SDR_OUT,
  ]);
}

/**
 * The shot taken to PQ with SDR white at `WHITE_NITS`, and the rendition laid over the photo.
 *
 * Tagged and subsampled like a rendition, 9/16/9 4:2:0 10-bit, so it is its own Firefox copy where
 * the platform shows video as a still (`demo-assets.ts`'s swatches).
 */
async function writeHdr(rect: Rect): Promise<void> {
  const pq = `t=smpte2084:p=bt2020:m=bt2020nc:r=limited:npl=${WHITE_NITS}`;
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      HERO_CAPTURE.shot,
      '-i',
      HERO_CAPTURE.photo,
      '-filter_complex',
      [
        `[0:v]zscale=tin=iec61966-2-1:pin=bt709:rin=full:${pq},format=yuv444p10le[page]`,
        // Resampled as light: averaging PQ codes averages a curve.
        `[1:v]zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:rin=limited:t=linear:npl=${WHITE_NITS},format=gbrpf32le,` +
          `zscale=w=${rect.width}:h=${rect.height}:filter=bilinear,zscale=${pq},format=yuv444p10le[photo]`,
        `[page][photo]overlay=x=${rect.x}:y=${rect.y}:format=yuv444p10,format=yuv420p10le[out]`,
      ].join(';'),
      '-map',
      '[out]',
      '-f',
      'yuv4mpegpipe',
      '-strict',
      '-1',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const quantizer = String(HDR_QUANTIZER);
  const encoded = run(
    'avifenc',
    [
      '--stdin',
      '--cicp',
      '9/16/9',
      // MaxFALL unknown (0): the page around the photo changes the frame's average.
      '--clli',
      `${Math.max(maxCllOf(HERO_CAPTURE.photo), WHITE_NITS)},0`,
      '--min',
      quantizer,
      '--max',
      quantizer,
      '-s',
      String(SPEED),
      hdrOut('still'),
    ],
    ffmpeg.stdout,
  );
  await Promise.all([exited(ffmpeg, 'ffmpeg'), encoded]);
  for (const matching of SDR_MATCHES.filter((matching) => matching !== 'still'))
    writeTenBitCopy(hdrOut('still'), hdrOut(matching), HDR_QUANTIZER, SPEED, matching);
}

const placed = PlacedSchema.parse(JSON.parse(readFileSync(HERO_CAPTURE.placed, 'utf8')));
const rect = drawnRect(placed, sizeOf(HERO_CAPTURE.photo));
await writeSdr();
await writeHdr(rect);
const kb = (file: string): string => `${(Bun.file(file).size / 1024).toFixed(0)}kB`;
console.error(
  `[hero] photo at ${rect.width}x${rect.height}+${rect.x}+${rect.y}: ${kb(SDR_OUT)} SDR, ${SDR_MATCHES.map((matching) => `${kb(hdrOut(matching))} HDR ${matching}`).join(', ')}`,
);

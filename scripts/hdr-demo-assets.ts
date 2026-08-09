// The picture pairs on `/hdr`, built by the app's own pipeline.
//
//   bun run scripts/hdr-demo-assets.ts [slug...]
//
// One `runJob` per photograph produces the HDR rendition, at the shipped defaults and
// at 1200px rather than 3840. **The 8-bit arm is then derived from that file** rather
// than asked for as a second target, and the difference matters more than it sounds.
//
// A library's SDR rendition is not the HDR one with its highlights removed: it comes
// off LibRaw's own sRGB output, auto-brightened and fitted to the camera's JPEG, where
// the HDR one is a scene-linear decode graded against a quantile. On a daylight frame
// the two land in nearly the same place; on a night frame they do not. Measured on the
// neon sign, the SDR arm sat at a black level of 0.06 with a red cast where the HDR
// arm was at 0.003 and neutral, and on the WC sign it was darker everywhere, not just
// in the highlights. Both are defensible renderings and neither is a bug - but a page
// whose whole claim is "the same picture, with less room at the top" cannot be built
// out of two pictures that disagree at the bottom.
//
// So the 8-bit arm is the HDR arm with its ceiling brought down to diffuse white:
// PQ decoded back to light, 203 nits tied to white, everything above it clipped, and
// the result written as 8-bit sRGB. No tone mapping, no second grade - a clamp and a
// colour conversion, which is exactly what the page says it is showing.
//
// The raw files are Play Raw submissions from discuss.pixls.us, each licensed CC
// BY-SA by its photographer. They are cached outside the repository, and only the
// renditions are committed, so a checkout needs neither 25MB per photograph nor a
// built `librawshim.so` to show the page.
//
// `bun run build:native` first: this goes through the same FFI the server does.
// `ffmpeg` and `avifenc` are needed too, as dev-stage tools (DESIGN §10.7).
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { SettingsSchema } from '../src/schemas/settings';
import { runJob, type JobTarget } from '../src/services/processing/rawshim_job';

interface Scene {
  /** Names the two files, and the page's entry for this picture. */
  slug: string;
  /** The Play Raw thread, which is where the credit and the licence live. */
  topic: number;
  /** The raw file itself, whose extension decides what LibRaw is handed. */
  url: string;
}

// The pictures on the page, in its order. Each is a case the page makes in words
// beside it, so a change here wants a look at `web/src/features/hdr/hdr_page.tsx`,
// which carries the photographer's name against the same slug.
// Chosen by measuring what each one actually keeps above white, not by subject: a
// photograph that loses nothing to the ceiling shows the reader nothing, however good
// the story beside it. Two earlier picks went for that reason, a moon over some roofs
// at 0.0% of its pixels and a pizzeria sign at 0.1%.
const SCENES: Scene[] = [
  { slug: 'beach', topic: 44432, url: 'https://discuss.pixls.us/uploads/short-url/zivNIARFeoOziUpK6ySmY3mmc6w.CR3' },
  { slug: 'snow', topic: 55869, url: 'https://discuss.pixls.us/uploads/short-url/4FBdaMDjyms79BbSplKr0yJcohg.ARW' },
  { slug: 'sunset', topic: 39131, url: 'https://discuss.pixls.us/uploads/short-url/fdehULtllGigrUp3tWRKRUvK6zk.CR2' },
  { slug: 'sign', topic: 33920, url: 'https://discuss.pixls.us/uploads/short-url/rjK5CIORCZhxCSdO2OunEJvnb91.ARW' },
];

/**
 * Long enough to look at, short enough to ship ten of them: the page is not a
 * pixel-peeping view, and every visitor pays for both arms of every pair.
 */
const LONG_EDGE = 1200;

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'web', 'public', 'hdr');
const CACHE = join(process.env.TMPDIR ?? '/tmp', 'bowerbird-hdr-raws');

/** Every rendition setting at its shipped default, so the page shows the shipped look. */
const SETTINGS = SettingsSchema.parse({});

/** How far above diffuse white the mastering peak sits: 1000 nits over 203, 2.3 stops. */
const PEAK_OVER_WHITE = SETTINGS.hdr_peak_nits / SETTINGS.hdr_reference_white_nits;

async function original(scene: Scene): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${scene.slug}${scene.url.slice(scene.url.lastIndexOf('.'))}`);
  if (existsSync(path)) return path;
  console.error(`[hdr-assets] fetching ${scene.slug}`);
  const res = await fetch(scene.url, { headers: { 'user-agent': 'bowerbird/hdr-demo-assets' } });
  if (!res.ok) throw new Error(`${scene.url}: HTTP ${res.status}`);
  await Bun.write(path, await res.arrayBuffer());
  return path;
}

function outputPath(slug: string, hdr: boolean): string {
  return join(OUT, `${slug}-${hdr ? 'hdr' : 'sdr'}.avif`);
}

function target(slug: string): JobTarget {
  return {
    rendition: 'full',
    hdr: true,
    outputPath: outputPath(slug, true),
    size: LONG_EDGE,
    source: 'render',
    sdrQuantizer: SETTINGS.full_rendition_quantizer,
    hdrQuantizer: SETTINGS.hdr_crf,
    preset: SETTINGS.hdr_preset,
    stillFullChroma: SETTINGS.hdr_still_full_chroma,
    sdrFullChroma: SETTINGS.sdr_full_chroma,
  };
}

function run(command: string, args: string[], stdin?: NodeJS.ReadableStream): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { stdio: [stdin == null ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
    const err: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${command} exited ${code}: ${Buffer.concat(err).toString()}`))));
    stdin?.pipe(child.stdin!);
  });
}

/**
 * The same picture with nowhere to put anything above white.
 *
 * zimg takes the PQ back to light with 203 nits tied to 1.0, and the sRGB transfer
 * clips whatever is above that - which is the entire operation. `avifenc` writes the
 * file because ffmpeg's muxer does not write the nclx `colr` box (§10.7), and the
 * quantizer is the one a stored SDR rendition would have been encoded at.
 */
async function clipToWhite(slug: string, wide = true): Promise<void> {
  const input = wide ? 'pin=bt2020:min=bt2020nc' : 'pin=bt709:min=bt709';
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', outputPath(slug, true),
    '-vf',
    `zscale=tin=smpte2084:${input}:npl=${SETTINGS.hdr_reference_white_nits}:t=iec61966-2-1:p=bt709:m=bt709:r=limited`,
    '-pix_fmt', SETTINGS.sdr_full_chroma ? 'yuv444p' : 'yuv420p',
    '-f', 'yuv4mpegpipe', '-strict', '-1', '-',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const quantizer = String(SETTINGS.full_rendition_quantizer);
  await run('avifenc', ['--stdin', '--cicp', '1/13/1', '--min', quantizer, '--max', quantizer, '-s', '4', outputPath(slug, false)], ffmpeg.stdout);
}

// The swatch strip that opens the page, which is not a photograph and not a scene.
//
// It answers the question every other picture on the page assumes an answer to: what
// does "brighter" mean once white is not the top. Each column is one colour at a fixed
// hue and saturation, stepped up in light alone, and the reader is meant to notice that
// the HDR strip stays that colour while the 8-bit one walks to white - not because
// anything was desaturated, but because raising a channel that is already at its
// ceiling is the one thing eight bits cannot do, so the other two rise instead.
const SWATCHES: [number, number, number][] = [
  [1, 0.06, 0.05], // red
  [1, 0.42, 0.03], // orange
  [0.06, 0.5, 1], // blue
  [0.1, 1, 0.25], // green
  // A light neutral rather than white, so this row still has one step to take before it
  // runs out. At white it would be five identical patches from the first column, which
  // reads as a broken image rather than as the point it is making - that the effect is
  // about the ceiling and not about colour.
  [0.72, 0.72, 0.72],
];

/**
 * Multiples of diffuse white across the strip, ending on the 1000-nit ceiling.
 *
 * **The first step is 1.0 and that is the whole trick.** At that step a colour's brightest
 * channel sits exactly on white, which is the brightest eight bits can render that hue
 * at all - so the strip opens on each colour at its best rather than working up to it.
 * Earlier versions started at 0.35 and then 0.8, and both read as dark on the left: a
 * saturated colour below white is dark by construction, since red carries a fifth of
 * white's luminance and blue a fourteenth. What the eye then read as the HDR row
 * lightening was really the row climbing out of that.
 */
const SWATCH_STEPS = [1, 1.5, 2.2, 3.3, PEAK_OVER_WHITE];

const SWATCH_CELL = 96;

/**
 * The strip, as scene-linear samples where 1.0 is diffuse white.
 *
 * **All three channels scale together, and they have to.** The HDR row does read as
 * getting somewhat lighter along its length, and holding the two minor channels while
 * only the dominant one climbs does cancel that - a row then deepens in colour as it
 * brightens. It was tried. It also flattens the 8-bit strip to nothing: that strip goes
 * pale *because* the minor channels are rising underneath a dominant one that has
 * already stopped, so holding them leaves five identical patches and there is no
 * comparison left to make.
 *
 * The two are one fact seen twice, and it cannot be had both ways. Light going up at a
 * fixed colour looks lighter, because that is what more light is; what the strip can
 * show is that the 8-bit row pays for it in colour and the HDR row does not. The copy
 * beside it claims that and not the stronger thing.
 *
 * Planar GBR because that is the one float layout that reaches zimg without swscale in
 * the way, which clamps to [0,1] and would flatten every step above white into one.
 */
function swatchFrame(): Float32Array {
  const [width, height] = [SWATCH_STEPS.length * SWATCH_CELL, SWATCHES.length * SWATCH_CELL];
  const pixels = width * height;
  const out = new Float32Array(pixels * 3);
  for (let y = 0; y < height; y++) {
    const colour = SWATCHES[Math.floor(y / SWATCH_CELL)]!;
    for (let x = 0; x < width; x++) {
      const step = SWATCH_STEPS[Math.floor(x / SWATCH_CELL)]!;
      const at = y * width + x;
      for (const [channel, plane] of [[0, 2], [1, 0], [2, 1]] as const) {
        out[plane * pixels + at] = colour[channel]! * step;
      }
    }
  }
  return out;
}

async function buildSwatches(): Promise<void> {
  const [width, height] = [SWATCH_STEPS.length * SWATCH_CELL, SWATCHES.length * SWATCH_CELL];
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${width}x${height}`, '-i', '-',
    // **Rec.709 primaries, not Rec.2020**, which is the one place these files differ from
    // every rendition the app writes. Converting the gamut first would take a saturated
    // Rec.709 red down to 0.65 of full scale before the transfer ever saw it, so the
    // first patch of the row would land at 130 nits where the strip says 203 - the HDR
    // strip would open dimmer than the 8-bit one and the whole comparison would read
    // backwards. Skipping the conversion makes 1.0 mean diffuse white exactly, and it
    // costs nothing here: these are flat sRGB colours with nothing outside 709 to carry.
    '-vf',
    `zscale=pin=bt709:tin=linear:min=bt709:p=bt709:t=smpte2084:m=bt709:r=limited:npl=${SETTINGS.hdr_reference_white_nits}`,
    '-pix_fmt', 'yuv444p10le',
    '-f', 'yuv4mpegpipe', '-strict', '-1', '-',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });
  const samples = swatchFrame();
  Readable.from([Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]).pipe(ffmpeg.stdin!);
  // 4:4:4 and lossless: flat colour has no detail to trade away, and a quantiser on a
  // hard edge between two saturated patches is visible where it is invisible on a
  // photograph. Also why the swatches skip the Firefox rewrap on the page - that path
  // needs 4:2:0 (§10.7).
  await run('avifenc', ['--stdin', '--cicp', '1/16/1', '--min', '0', '--max', '0', '-s', '4', outputPath('swatches', true)], ffmpeg.stdout!);
  await clipToWhite('swatches', false);
}

async function build(scene: Scene): Promise<void> {
  const rawFilePath = await original(scene);
  try {
    runJob({
      rawFilePath,
      matchEmbeddedJpeg: SETTINGS.match_embedded_jpeg,
      denoiseLuma: SETTINGS.raw_denoise_luma,
      denoiseChroma: SETTINGS.raw_denoise_chroma,
      sharpen: SETTINGS.raw_sharpen,
      defringe: SETTINGS.raw_defringe,
      grade: {
        peakNits: SETTINGS.hdr_peak_nits,
        referenceWhiteNits: SETTINGS.hdr_reference_white_nits,
        whiteQuantile: SETTINGS.hdr_white_quantile,
      },
      targets: [target(scene.slug)],
    });
    await clipToWhite(scene.slug);
  } catch (failure) {
    // The HDR arm lands before the 8-bit one is derived from it, so a failure in the
    // second step leaves the first behind - and these outputs are committed, where a
    // half-built pair is a picture the page shows against one it does not. The worker
    // cleans up for the same reason (`processing_worker.ts`).
    for (const hdr of [false, true]) await Bun.file(outputPath(scene.slug, hdr)).delete().catch(() => {});
    throw failure;
  }

  const sizes = [false, true].map((hdr) => Bun.file(outputPath(scene.slug, hdr)).size);
  console.error(`[hdr-assets] ${scene.slug}: ${(sizes[0]! / 1024).toFixed(0)}kB SDR, ${(sizes[1]! / 1024).toFixed(0)}kB HDR`);
}

const asked = process.argv.slice(2);
const wanted = asked.length === 0 ? SCENES : SCENES.filter((scene) => asked.includes(scene.slug));
const swatches = asked.length === 0 || asked.includes('swatches');
if (wanted.length === 0 && !swatches) throw new Error(`no such scene: ${asked.join(', ')}`);
mkdirSync(OUT, { recursive: true });
if (swatches) await buildSwatches();
for (const scene of wanted) await build(scene);

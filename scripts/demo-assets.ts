// The committed demo pictures, built by the app's own pipeline: the pairs on `/hdr`, and
// the colour matching pair the landing site's demo swaps between.
//
//   BOWERBIRD_DEMO_GAMUT=<a raw> BOWERBIRD_DEMO_WHITES=<a raw> ... bun run scripts/demo-assets.ts [slug...]
//
// One variable per picture, named for its slug (`rawFor`), and a run only asks for the
// pictures it is building.
//
// One `runJob` per photograph produces the HDR rendition, at the shipped defaults and
// at 1200px rather than 3840. **The 8-bit arm is then derived from that file** rather
// than asked for as a second target, and the difference matters more than it sounds.
//
// A library's SDR rendition is not the HDR one with its highlights removed: it comes
// off the decoder's own sRGB output, fitted to the camera's JPEG, where
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
// The raw files are the maintainer's own and every one of them is passed in, so this does
// not run on a fresh checkout and does not need to: the renditions are committed and the
// page serves those.
//
// `bun run build:native` first: this goes through the same FFI the server does.
// `ffmpeg` and `avifenc` are needed too, as dev-stage tools (DESIGN §10.7).
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { canvasLongEdgeFor } from '../src/schemas/composition';
import { AlignedSchema, type Aligned } from '../src/schemas/recipes';
import { SettingsSchema } from '../src/schemas/settings';
import { dustSettings } from '../src/schemas/dust_settings';
import { AS_METERED } from '../src/services/processing/pipeline/developed';
import { encoderQuality } from '../src/services/processing/analysis/quality';
import type { Job, JobCompositeSource, JobTarget } from '../src/schemas/jobs';
import { runJob } from '../src/services/processing/rawshim/rawshim_job';

/**
 * Where a picture's raw is, read from the variable named after its slug.
 *
 * **Nothing about the originals is written down here** - not a path, not a directory, not a
 * filename. They live in a photo library rather than in this repository, and a library's
 * shape is its owner's: the folders are their trips and their rejects, and a camera's own
 * name for a frame is enough to ask after the rest of the album. So every one of them is
 * passed in, and this file knows only what it calls the picture.
 */
function rawFor(slug: string): string {
  const variable = `BOWERBIRD_DEMO_${slug.toUpperCase().replaceAll('-', '_')}`;
  const path = process.env[variable];
  if (path == null || path === '') throw new Error(`${variable} must name the raw to build ${slug} from`);
  return path;
}

// The pictures on the page, in its order. Each is a case the page makes in words
// beside it, so a change here wants a look at `web/src/features/hdr/hdr_page.tsx`.
const SCENES: readonly string[] = ['gamut', 'whites', 'sun', 'saturated'];

/**
 * The landing site's colour matching demo, which is one picture rendered two ways.
 *
 * The same photograph as `whites`, and pointed at by a variable of its own rather than
 * borrowing that one: which raw a slug is built from is the caller's to say, every time.
 */
const COLOUR = 'colour';

const NEUTRAL_EXPOSURE = -0.9;

/**
 * The landing site's take best parts demo: two frames of one street, a moment apart.
 *
 * Shot back to back on the same camera, so the frames line up closely enough that a piece
 * of one dropped into the other reads as one photograph. What moves between them is people.
 */
const MERGE: readonly string[] = ['merge-a', 'merge-b'];

/**
 * The frames the panorama demo is merged from, left to right across the finished picture.
 *
 * The sweep is numbered as it reads rather than as it was shot, so a strip of these under the
 * panorama runs the same way the picture does. Which frame is which is the caller's to point at.
 */
const PANORAMA: readonly string[] = [1, 2, 3, 4, 5].map((at) => `pano-${at}`);

/** The dust removal demo's frame, which has a dirty sensor's spots in its sky. */
const DUST = 'dust';

/**
 * The part of that frame the demo shows, as Camera Raw's left, top, right and bottom.
 *
 * A spot is a few sensor pixels across, so the whole frame at the width the page draws it is not
 * a demonstration of anything: measured over the pair, the 44 spots the removal moved are 3 to 9
 * pixels wide at 1200px, which is under 6 on screen. This rectangle is a twentieth of the frame
 * and holds 4 of them at 23 to 25 pixels, all left of where the divider starts, so the reader
 * drags over spots rather than towards them.
 */
const DUST_CROP: [number, number, number, number] = [0.49, 0.13, 0.71, 0.35];

/**
 * The part of a scene's frame the page shows, as Camera Raw's left, top, right and bottom.
 *
 * A scene is only a case about headroom if the thing carrying the highlights is big enough to
 * look at: the seabird is a tenth of its frame's width, so the lit wing that the HDR arm holds
 * and the 8-bit one clips is a few pixels on screen. This rectangle is a quarter of the frame,
 * cut from the raw rather than from the rendition so the picture is still 1200px of detail.
 */
const SCENE_CROP: Record<string, [number, number, number, number]> = {
  saturated: [0.333, 0.25, 0.833, 0.75],
};

/**
 * Long enough to look at, short enough to ship ten of them: the page is not a
 * pixel-peeping view, and every visitor pays for both arms of every pair.
 */
const LONG_EDGE = 1200;

/** Wider than a photograph, so its long edge buys less height than everything else here. */
const PANORAMA_EDGE = 2000;

/** A panorama's frames are shown in a strip under it, at a thumbnail's size. */
const FRAME_EDGE = 400;

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'web', 'public', 'hdr');
const LANDING_OUT = join(ROOT, 'landing', 'public', 'samples');

/** Every rendition setting at its shipped default, so the page shows the shipped look. */
const SETTINGS = SettingsSchema.parse({});

/** How far above diffuse white the mastering peak sits: 1000 nits over 203, 2.3 stops. */
const PEAK_OVER_WHITE = SETTINGS.hdr_peak_nits / SETTINGS.hdr_reference_white_nits;

/** A target's size is the long edge of the whole frame, so a crop asks for what it is about to take away. */
function croppedSize(crop: [number, number, number, number]): number {
  return Math.round(LONG_EDGE / (crop[2] - crop[0]));
}

function outputPath(slug: string, hdr: boolean): string {
  return join(OUT, `${slug}-${hdr ? 'hdr' : 'sdr'}.avif`);
}

function colourPath(profile: 'matched' | 'none'): string {
  return join(LANDING_OUT, `colour-${profile}.avif`);
}

function target(slug: string): JobTarget {
  return {
    rendition: 'full',
    output: 'pq',
    outputPath: outputPath(slug, true),
    size: LONG_EDGE,
    source: 'render',
    sdrQuantizer: encoderQuality('avif-sdr', SETTINGS.full_rendition_quality),
    hdrQuantizer: encoderQuality('avif-hdr', SETTINGS.full_rendition_quality),
    preset: SETTINGS.avif_speed,
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
  const quantizer = String(encoderQuality('avif-sdr', SETTINGS.full_rendition_quality));
  await run('avifenc', ['--stdin', '--cicp', '1/13/1', '--min', quantizer, '--max', quantizer, '-s', '4', outputPath(slug, false)], ffmpeg.stdout);
}

// The swatch strip that opens the page, which is not a photograph and not a scene.
//
// It answers the question every other picture on the page assumes an answer to: what
// does "brighter" mean once white is not the top. Each column is one colour at a fixed
// hue and saturation, stepped up in light alone, and the reader is meant to notice that
// the HDR half stays that colour while the 8-bit half walks to white - not because
// anything was desaturated, but because raising a channel that is already at its
// ceiling is the one thing eight bits cannot do, so the other two rise instead.
//
// **Both halves live in one PQ file**, which is what makes it work on an ordinary
// screen. A standard-range browser renders PQ by fixing its own white at about 406 nits,
// measured, so an sRGB image shown beside a PQ one is painted about a quarter brighter
// than it for reasons that have nothing to do with the argument - which is what two
// files, side by side or swapped, kept showing. Inside a single file that tone map
// applies to every patch equally, so whatever the screen does to one half it does to
// the other, and what is left is the comparison. On a real HDR screen the left half
// simply cannot exceed diffuse white, which is the point stated as a brightness rather
// than as a caption.
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

/** Between the two halves, in cells. Black, so neither half bleeds into the other. */
const SWATCH_GAP = 0.25;

/**
 * Corner rounding, in samples, drawn into the frame rather than left to CSS.
 *
 * A radius on the `<img>` rounds the outside of the pair and leaves the two inner
 * corners square, which is what a single image gets you. The alternative - masking the
 * two halves in CSS - is out: a mask forces the subtree to rasterise into an SDR
 * intermediate and the PQ tagging goes with it (§10.7).
 */
const SWATCH_RADIUS = 6;

const SWATCH_WIDTH = Math.round((SWATCH_STEPS.length * 2 + SWATCH_GAP) * SWATCH_CELL);
const SWATCH_HEIGHT = SWATCHES.length * SWATCH_CELL;

/**
 * Both halves in one frame, as scene-linear samples where 1.0 is diffuse white.
 *
 * The left half is the same colours with every channel clamped at white, which is the
 * whole of what eight bits can hold: the dominant channel stops there and the other two
 * climb into it, so the row goes pale and its brightness stops dead. The right half is
 * the same numbers left alone, up to the 1000-nit ceiling.
 *
 * **All three channels scale together, which is the only construction that means "the
 * same colour with more light on it".** Scaling a triple leaves its chromaticity where
 * it was, so hue and saturation are both held exactly and only the light changes.
 *
 * The tempting alternative is to raise the dominant channel alone and hold the other
 * two. It does stop the HDR row reading as lighter, and it is wrong: measured across the
 * row it walked the orange from hue 24 degrees to 5 - orange into red - and the blue from
 * 212 to 235. A strip whose caption says the colour is unchanged cannot be quietly
 * turning one colour into another, and swapping a lightness error for a hue error is not
 * a fix.
 *
 * So the row does get lighter along its length, because more light is what it has. What
 * the strip shows is where that light goes: into the colour on the right, and into white
 * on the left, which has nowhere else to put it.
 *
 * Planar GBR because that is the one float layout that reaches zimg without swscale in
 * the way, which clamps to [0,1] and would flatten every step above white into one.
 */
/** Whether a sample is inside a rectangle whose corners are rounded off. */
function inRounded(x: number, y: number, left: number, right: number, radius: number): boolean {
  const dx = Math.max(left + radius - x, x - (right - radius), 0);
  const dy = Math.max(radius - y, y - (SWATCH_HEIGHT - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

/** Linear Rec.709 to linear Rec.2020, the published 3x3. */
const TO_2020 = [
  [0.627404, 0.329283, 0.043313],
  [0.069097, 0.91954, 0.011362],
  [0.016391, 0.088013, 0.895595],
];

/**
 * How much to scale a colour by after moving it to Rec.2020 so its brightest channel
 * lands exactly on diffuse white.
 *
 * **The conversion happens here rather than in zimg so the file can be tagged 9/16/9**,
 * which is what every HDR rendition this app writes and what every engine has a path
 * for. Tagging it 1/16/1 dodged the conversion, worked in Chromium, and is a combination
 * nothing else has reason to expect.
 *
 * The scale is what makes dodging it unnecessary. The conversion pulls a saturated
 * Rec.709 red down to 0.65 of full scale, so multiplying the triple back up by 1/max puts
 * the brightest channel on 1.0 again - and scaling all three preserves chromaticity, so
 * it is the same colour stated in the wider space.
 */
function whitePoint(colour: [number, number, number]): number {
  return 1 / Math.max(...TO_2020.map((row) => row[0]! * colour[0]! + row[1]! * colour[1]! + row[2]! * colour[2]!));
}

/**
 * One sRGB triple in Rec.2020, at `scale`.
 *
 * **The 8-bit half is clipped before this runs and not after**, because the clip is the
 * thing being demonstrated and it is an sRGB clip: a JPEG's channels stop at sRGB's
 * ceiling, not at Rec.2020's. Clipping in the wide space instead walks the reds to a
 * khaki and the blues to a grey-green, which is not what any JPEG has ever done.
 */
function toRec2020(colour: number[], scale: number): number[] {
  return TO_2020.map((row) => (row[0]! * colour[0]! + row[1]! * colour[1]! + row[2]! * colour[2]!) * scale);
}

function swatchFrame(): Float32Array {
  const pixels = SWATCH_WIDTH * SWATCH_HEIGHT;
  const out = new Float32Array(pixels * 3);
  const half = SWATCH_STEPS.length * SWATCH_CELL;
  const right = SWATCH_WIDTH - half;

  for (let y = 0; y < SWATCH_HEIGHT; y++) {
    const colour = SWATCHES[Math.floor(y / SWATCH_CELL)]!;
    const scale = whitePoint(colour);
    for (let x = 0; x < SWATCH_WIDTH; x++) {
      // The gap between the halves, and the eight rounded corners, stay black.
      const eightBit = x < half;
      if (!eightBit && x < right) continue;
      const [from, to] = eightBit ? [0, half] : [right, SWATCH_WIDTH];
      if (!inRounded(x + 0.5, y + 0.5, from, to, SWATCH_RADIUS)) continue;
      const step = SWATCH_STEPS[Math.floor((eightBit ? x : x - right) / SWATCH_CELL)]!;
      // Still sRGB here, which is where the 8-bit ceiling belongs.
      const srgb = colour.map((level) => (eightBit ? Math.min(level * step, 1) : level * step));
      const wide = toRec2020(srgb, scale);
      const at = y * SWATCH_WIDTH + x;
      for (const [channel, plane] of [[0, 2], [1, 0], [2, 1]] as const) {
        out[plane * pixels + at] = wide[channel]!;
      }
    }
  }
  return out;
}

/**
 * What the file declares about its own brightness, in nits.
 *
 * `MaxCLL` is the brightest single sample and `MaxPALL` the frame's average of the
 * per-pixel maximum, both computed off the samples rather than asserted, so they cannot
 * drift from what the strip actually holds. Measured, Chrome ignores it for stills - it
 * paints a PQ file against a fixed white either way - but it is correct information the
 * file was otherwise missing, and other engines do read it.
 */
function contentLight(samples: Float32Array): string {
  const pixels = samples.length / 3;
  let peak = 0;
  let total = 0;
  for (let at = 0; at < pixels; at++) {
    const top = Math.max(samples[at]!, samples[pixels + at]!, samples[2 * pixels + at]!);
    if (top > peak) peak = top;
    total += top;
  }
  const nits = (level: number): number => Math.round(level * SETTINGS.hdr_reference_white_nits);
  return `${nits(peak)},${nits(total / pixels)}`;
}

/**
 * The strip, from linear samples straight to one PQ file.
 *
 * **Tagged and subsampled exactly like a rendition**: Rec.2020 primaries, PQ, 4:2:0,
 * 9/16/9. The samples arrive already in Rec.2020 (`inRec2020`) so zimg has no gamut work
 * to do and 1.0 still means diffuse white.
 *
 * It was 4:4:4 at 1/16/1 - Rec.709 primaries with a PQ transfer - which dodged the gamut
 * conversion and rendered correctly in Chromium. Neither half of that is a combination
 * another engine has any reason to expect: 4:4:4 is the one thing Firefox will not
 * composite in HDR (§10.7), and 709-with-PQ is not a colour space anything ships a path
 * for. Every photograph on the page is 9/16/9 4:2:0 and behaves, so the strip is now the
 * same shape of file and stops being the odd one out.
 *
 * Losslessly quantised, since flat colour has no detail to trade away. 4:2:0 softens the
 * hard edge between two patches by a pixel or so, which is invisible at 96px cells and
 * cheaper than being the only file here that no other browser has seen before.
 */
async function buildSwatches(): Promise<void> {
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${SWATCH_WIDTH}x${SWATCH_HEIGHT}`, '-i', '-',
    '-vf',
    `zscale=pin=bt2020:tin=linear:min=bt2020nc:p=bt2020:m=bt2020nc:r=limited:t=smpte2084:npl=${SETTINGS.hdr_reference_white_nits}`,
    '-pix_fmt', 'yuv420p10le',
    '-f', 'yuv4mpegpipe', '-strict', '-1', '-',
  ], { stdio: ['pipe', 'pipe', 'inherit'] });
  const samples = swatchFrame();
  Readable.from([Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]).pipe(ffmpeg.stdin!);
  const out = join(OUT, 'swatches.avif');
  await run('avifenc', ['--stdin', '--cicp', '9/16/9', '--clli', contentLight(samples), '--min', '0', '--max', '0', '-s', '4', out], ffmpeg.stdout!);
  console.error(`[demo-assets] swatches: ${(Bun.file(out).size / 1024).toFixed(0)}kB`);
}

/**
 * The landing site's colour matching demo: the same raw with the camera's colour and without.
 *
 * Both arms are 8-bit sRGB, where the pairs above are HDR. The claim here is about hue rather
 * than headroom, so the pair has to read correctly on the ordinary screen most visitors have,
 * and a PQ file on one of those is painted about a quarter dim.
 *
 * `match_embedded_jpeg` stays on in both: it decides whether the profile is *fitted*, and the
 * document's `colourProfile` decides whether the fit is used. Turning the setting off instead
 * would compare a fitted render against one that never measured anything, which is not the
 * switch the editor offers.
 */
async function buildColour(): Promise<void> {
  const raw = rawFor(COLOUR);
  for (const profile of ['matched', 'none'] as const) {
    renderSrgb(raw, colourPath(profile), profile, profile === 'none' ? NEUTRAL_EXPOSURE : null);
    console.error(`[demo-assets] colour ${profile}: ${(Bun.file(colourPath(profile)).size / 1024).toFixed(0)}kB`);
  }
}

/** The take best parts demo's frames, which are two photographs rather than two renderings of one. */
async function buildMerge(): Promise<void> {
  for (const frame of MERGE) {
    const out = join(LANDING_OUT, `${frame}.avif`);
    renderSrgb(rawFor(frame), out, 'matched');
    console.error(`[demo-assets] ${frame}: ${(Bun.file(out).size / 1024).toFixed(0)}kB`);
  }
}

/**
 * The panorama demo: five frames of one sweep, and what the merge makes of them.
 *
 * The align searches the frames for a recipe - where each one sits in the finished picture - and
 * the render composites them against it, which is what the server runs (`CompositesService`). A
 * set that does not align is a refusal rather than a bad picture, so there is nothing to check
 * afterwards.
 */
async function buildPanorama(): Promise<void> {
  const sources: JobCompositeSource[] = PANORAMA.map((frame, at) => ({
    // A source is keyed the way a library keys a photograph, which the recipe's schema holds to.
    photoId: `pano000${at}`,
    rawFilePath: rawFor(frame),
  }));
  const job: Omit<Job, 'targets'> = {
    rawFilePath: sources[0]!.rawFilePath,
    cameraMatch: SETTINGS.match_embedded_jpeg ? 'lensAndColour' : 'none',
    defringe: SETTINGS.raw_defringe,
    ...AS_METERED,
    grade: {
      peakNits: SETTINGS.hdr_peak_nits,
      referenceWhiteNits: SETTINGS.hdr_reference_white_nits,
      whiteQuantile: SETTINGS.hdr_white_quantile,
    },
  };

  let aligned = align(job, sources);
  // A recipe is stated in the camera's corrected geometry, so the composite reaches each raw
  // through that lens's ratio table - and the table is fitted inside a render, which nothing here
  // has run. Stitched without one, every seam doubles its edges, so the lens is measured and the
  // set aligned again, as `CompositesService.aligned` does it.
  for (const photoId of aligned.lensless) {
    const source = sources.find((each) => each.photoId === photoId)!;
    const fit = runJob({ ...job, rawFilePath: source.rawFilePath, cameraMatch: 'lensAndColour', measure: true, targets: [] });
    if (fit.photoAnalysis == null) throw new Error(`nothing could fit the lens ${source.rawFilePath} was shot on`);
    source.photoAnalysis = Array.from(fit.photoAnalysis);
  }
  if (aligned.lensless.length > 0) aligned = align(job, sources);

  const { recipe, dropped, lensless } = aligned;
  if (dropped.length > 0) throw new Error(`the align left ${dropped.join(', ')} out of the panorama`);
  if (lensless.length > 0) throw new Error(`the lens ${lensless.join(', ')} was shot on is still unfitted`);

  const out = join(LANDING_OUT, 'panorama.avif');
  runJob({
    ...job,
    // The wedges of nothing a hand-held pan leaves at the canvas's corners, trimmed the way a
    // merge trims them: the align's own crop, on the field every render already takes.
    geometry: { ...AS_METERED.geometry, crop: recipe.crop },
    targets: [
      { ...target('panorama'), output: 'srgb', outputPath: out, size: canvasLongEdgeFor(recipe, PANORAMA_EDGE) },
    ],
    composite: { want: 'render', recipe: { ...recipe, kind: 'panorama' }, sources },
  });
  console.error(`[demo-assets] panorama: ${(Bun.file(out).size / 1024).toFixed(0)}kB`);

  for (const frame of PANORAMA) {
    const path = join(LANDING_OUT, `${frame}.avif`);
    renderSrgb(rawFor(frame), path, 'matched', null, FRAME_EDGE);
  }
}

function align(job: Omit<Job, 'targets'>, sources: JobCompositeSource[]): Aligned {
  const answered = runJob({ ...job, targets: [], composite: { want: 'align', shape: 'pan', sources } });
  if (answered.composite == null) throw new Error('the panorama frames did not align');
  return AlignedSchema.parse(JSON.parse(answered.composite));
}

/**
 * The dust removal demo: one frame with the spots left in, and the same frame with them taken out.
 *
 * The only pair here that differs by a stage rather than by a setting of the grade, so both arms
 * are the shipped render and the switch is the one the edit panel offers.
 */
async function buildDust(): Promise<void> {
  const raw = rawFor(DUST);
  for (const [slug, dust] of [
    ['dust-before', { ...dustSettings(undefined), enabled: false }],
    ['dust-after', dustSettings(undefined)],
  ] as const) {
    const out = join(LANDING_OUT, `${slug}.avif`);
    runJob({
      rawFilePath: raw,
      cameraMatch: SETTINGS.match_embedded_jpeg ? 'lensAndColour' : 'none',
      defringe: SETTINGS.raw_defringe,
      ...AS_METERED,
      dust,
      geometry: { ...AS_METERED.geometry, crop: DUST_CROP },
      grade: {
        peakNits: SETTINGS.hdr_peak_nits,
        referenceWhiteNits: SETTINGS.hdr_reference_white_nits,
        whiteQuantile: SETTINGS.hdr_white_quantile,
      },
      targets: [{ ...target(DUST), output: 'srgb', outputPath: out, size: croppedSize(DUST_CROP) }],
    });
    console.error(`[demo-assets] ${slug}: ${(Bun.file(out).size / 1024).toFixed(0)}kB`);
  }
}

/** One 8-bit picture at the shipped settings, which is what the landing site's demos show. */
function renderSrgb(
  raw: string,
  outputPath: string,
  colourProfile: 'matched' | 'none',
  exposure: number | null = null,
  size = LONG_EDGE,
): void {
  runJob({
    rawFilePath: raw,
    cameraMatch: SETTINGS.match_embedded_jpeg ? 'lensAndColour' : 'none',
    defringe: SETTINGS.raw_defringe,
    ...AS_METERED,
    exposure,
    adjust: { ...AS_METERED.adjust, colourProfile },
    grade: {
      peakNits: SETTINGS.hdr_peak_nits,
      referenceWhiteNits: SETTINGS.hdr_reference_white_nits,
      whiteQuantile: SETTINGS.hdr_white_quantile,
    },
    targets: [{ ...target(COLOUR), output: 'srgb', outputPath, size }],
  });
}

async function build(scene: string): Promise<void> {
  const crop = SCENE_CROP[scene];
  try {
    runJob({
      rawFilePath: rawFor(scene),
      cameraMatch: SETTINGS.match_embedded_jpeg ? 'lensAndColour' : 'none',
      defringe: SETTINGS.raw_defringe,
      // The page shows the shipped look, so the frames carry no develop settings - the
      // denoise included, `AS_METERED` carrying the document's own defaults for it.
      ...AS_METERED,
      geometry: crop == null ? AS_METERED.geometry : { ...AS_METERED.geometry, crop },
      grade: {
        peakNits: SETTINGS.hdr_peak_nits,
        referenceWhiteNits: SETTINGS.hdr_reference_white_nits,
        whiteQuantile: SETTINGS.hdr_white_quantile,
      },
      targets: [crop == null ? target(scene) : { ...target(scene), size: croppedSize(crop) }],
    });
    await clipToWhite(scene);
  } catch (failure) {
    // The HDR arm lands before the 8-bit one is derived from it, so a failure in the
    // second step leaves the first behind - and these outputs are committed, where a
    // half-built pair is a picture the page shows against one it does not. The worker
    // cleans up for the same reason (`processing_worker.ts`).
    for (const hdr of [false, true]) await Bun.file(outputPath(scene, hdr)).delete().catch(() => {});
    throw failure;
  }

  const sizes = [false, true].map((hdr) => Bun.file(outputPath(scene, hdr)).size);
  console.error(`[demo-assets] ${scene}: ${(sizes[0]! / 1024).toFixed(0)}kB SDR, ${(sizes[1]! / 1024).toFixed(0)}kB HDR`);
}

const asked = process.argv.slice(2);
const wanted = asked.length === 0 ? SCENES : SCENES.filter((scene) => asked.includes(scene));
const swatches = asked.length === 0 || asked.includes('swatches');
const colour = asked.length === 0 || asked.includes(COLOUR);
const merge = asked.length === 0 || asked.includes('merge');
const panorama = asked.length === 0 || asked.includes('panorama');
const dust = asked.length === 0 || asked.includes(DUST);
if (wanted.length === 0 && !swatches && !colour && !merge && !panorama && !dust) {
  throw new Error(`no such scene: ${asked.join(', ')}`);
}
mkdirSync(OUT, { recursive: true });
mkdirSync(LANDING_OUT, { recursive: true });
if (swatches) await buildSwatches();
if (colour) await buildColour();
if (merge) await buildMerge();
if (panorama) await buildPanorama();
if (dust) await buildDust();
for (const scene of wanted) await build(scene);

// The camera's colour treatment, fitted for the HDR path (DESIGN §10.8).
//
// The SDR fit (`jpeg_match.ts`) works entirely in 8-bit sRGB: its curves are
// indexed by an 8-bit render level and answer with an 8-bit JPEG level. That
// cannot be lifted to HDR, for two reasons that are both fatal rather than
// approximate. Its domain stops at display white, so it has nothing to say about
// the scene above it - which is the whole of what HDR adds. And 8 bits of output
// is coarser than the shadows of a PQ signal, so applying it would band.
//
// So the geometry is reused - it is a property of the lens, not of a colour space
// - and only the colour is refitted, in the domain the grade actually works in:
// Rec.2020 linear, normalised so diffuse white is 1.0. That makes the curve
// extrapolable, which is what lets the camera's rendering stop at diffuse white
// and BT.2390 take over above it (§10.7.1).

import sharp from 'sharp';
import { deltaE76, warp, type MatchProfile } from './jpeg_match';
import type { DecodedImage } from './raw_decoder';

// Long edge of the grid the fit runs on. Matching `jpeg_match.ts`: fitting small
// and applying at full resolution is free, and a 60MP fit is minutes of work for
// the same answer.
const FIT_LONG_EDGE = 640;

// Curve resolution over the fit domain.
const BINS = 256;

/**
 * How far above diffuse white the JPEG is still believed, as a fraction of it.
 *
 * Not 1.0: the last stop before an 8-bit image clips is the camera compressing
 * highlights into a range it does not have, and a curve fitted through that
 * learns the compression as though it were colour. Cut below it and the shoulder
 * is never seen.
 */
export const TRUST_CEILING = 0.9;

const MIN_BIN_SAMPLES = 8;
const MIN_PAIRS = 2000;

// Rec.2020 luma, for the chroma blend and the sample weighting.
const LUMA = [0.2627, 0.678, 0.0593] as const;

const SRGB_TO_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];
const XYZ_TO_REC2020 = [
  [1.7166512, -0.3556708, -0.2533663],
  [-0.6666844, 1.6164812, 0.0157685],
  [0.0176399, -0.0427706, 0.9421031],
];

function multiply(a: number[][], b: number[][]): number[][] {
  return a.map((row) => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));
}

const SRGB_TO_REC2020 = multiply(XYZ_TO_REC2020, SRGB_TO_XYZ);

function apply3(m: number[][], r: number, g: number, b: number): [number, number, number] {
  return [
    m[0]![0]! * r + m[0]![1]! * g + m[0]![2]! * b,
    m[1]![0]! * r + m[1]![1]! * g + m[1]![2]! * b,
    m[2]![0]! * r + m[2]![1]! * g + m[2]![2]! * b,
  ];
}

const SRGB_EOTF = new Float64Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_EOTF[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export interface HdrColour {
  /** Per-channel, `BINS` samples spanning render values 0 to TRUST_CEILING. */
  curves: [Float64Array, Float64Array, Float64Array];
  /** Applied after the curves; row-major, output channel by input channel. */
  matrix: number[][];
  /** Blend towards luma afterwards; 1 leaves chroma alone. */
  saturation: number;
  /** Held-out mean deltaE76 over the fit pairs, for reporting. */
  deltaE: number;
}

interface Plane {
  width: number;
  height: number;
  data: Float64Array; // interleaved RGB, linear, 1.0 = diffuse white
}

// ------------------------------------------------------------------ the pair

// Box average, and done here rather than through sharp because sharp's raw path
// reports `depth: uchar` for a 16-bit input and hands back 8-bit samples. That
// left ~57 distinct levels across the whole fit domain once the scene-linear data
// was normalised, and the curve fitted from that staircase was visibly contrasty.
// Doing both sides here also means neither gets a filter the other did not.
function resample(src: Float64Array, sw: number, sh: number, dw: number, dh: number): Float64Array {
  const out = new Float64Array(dw * dh * 3);
  const xs = sw / dw;
  const ys = sh / dh;
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor(dy * ys);
    const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * ys));
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor(dx * xs);
      const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * xs));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * sw + x) * 3;
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (dy * dw + dx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

// Three box passes, which is close enough to a Gaussian here. Both images are
// blurred before pairing for the same reason the SDR fit does it: the camera's
// sharpening and noise reduction are not reproducible and must not leak into the
// colour fit, and residual misregistration stops mattering once neither image has
// detail at that scale.
const FIT_BLUR_RADIUS = 2;

function blurPlane(plane: Plane, radius: number): void {
  if (radius < 1) return;
  const { width: w, height: h, data } = plane;
  const tmp = new Float64Array(data.length);
  for (let pass = 0; pass < 3; pass += 1) {
    for (const horizontal of [true, false]) {
      const src = horizontal ? data : tmp;
      const dst = horizontal ? tmp : data;
      const span = horizontal ? w : h;
      const lines = horizontal ? h : w;
      for (let line = 0; line < lines; line += 1) {
        for (let i = 0; i < span; i += 1) {
          const lo = Math.max(0, i - radius);
          const hi = Math.min(span - 1, i + radius);
          let r = 0;
          let g = 0;
          let b = 0;
          for (let k = lo; k <= hi; k += 1) {
            const idx = (horizontal ? line * w + k : k * w + line) * 3;
            r += src[idx]!;
            g += src[idx + 1]!;
            b += src[idx + 2]!;
          }
          const n = hi - lo + 1;
          const o = (horizontal ? line * w + i : i * w + line) * 3;
          dst[o] = r / n;
          dst[o + 1] = g / n;
          dst[o + 2] = b / n;
        }
      }
    }
  }
}

function luma(data: Float64Array, i: number): number {
  return LUMA[0] * data[i]! + LUMA[1] * data[i + 1]! + LUMA[2] * data[i + 2]!;
}

// ------------------------------------------------------------------ the mask

// Bit c is set when channel c of this pixel is usable on its own; bit 3 when all
// three are.
//
// The distinction is load-bearing. A per-channel curve only needs its own channel
// in range, and requiring all three threw away most of the samples at the top of
// red's and green's domains: in a sky it is blue that is near clipping, so every
// sky pixel was dropped from red's curve as well. Both curves then ran out of
// data well below the ceiling and were extrapolated from there, which tinted the
// upper mid-tones magenta - measured at deltaA* +5.2 in the 75-89 L* band, on
// pixels that sit *inside* the fit domain. The matrix still wants all three,
// being cross-channel.
const ALL = 8;

function mask(render: Plane, jpeg: Plane): Uint8Array {
  const { width, height } = render;
  const out = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const i = p * 3;
      // A black warp margin is not scene content.
      if (render.data[i]! === 0 && render.data[i + 1]! === 0 && render.data[i + 2]! === 0) continue;

      let bits = 0;
      for (let c = 0; c < 3; c += 1) {
        if (jpeg.data[i + c]! < 0.94 && render.data[i + c]! < TRUST_CEILING) bits |= 1 << c;
      }
      if (bits === 0) continue;
      if (bits === 0b111) bits |= ALL;

      // Gradient on the square root of luma rather than on linear light. A fixed
      // linear threshold is not the same test at both ends - in the shadows
      // almost nothing exceeds it and in the sky almost everything does - so the
      // surviving pixels come from the dark half of the frame and the curve is
      // fitted where it has least to say.
      const at = (dx: number, dy: number): number =>
        Math.sqrt(Math.max(0, luma(jpeg.data, ((y + dy) * width + (x + dx)) * 3)));
      if (Math.abs(at(1, 0) - at(-1, 0)) + Math.abs(at(0, 1) - at(0, -1)) > 0.03) continue;
      out[p] = bits;
    }
  }
  return out;
}

// ------------------------------------------------------------------- the model

/** Binned mean, gaps interpolated, ends extended at the last slope, then monotone. */
function fitCurve(xs: Float64Array, ys: Float64Array, n: number): Float64Array {
  const sum = new Float64Array(BINS);
  const count = new Float64Array(BINS);
  for (let i = 0; i < n; i += 1) {
    const bin = Math.min(BINS - 1, Math.max(0, Math.round((xs[i]! / TRUST_CEILING) * (BINS - 1))));
    sum[bin]! += ys[i]!;
    count[bin]! += 1;
  }

  const curve = new Float64Array(BINS);
  let last = -1;
  for (let b = 0; b < BINS; b += 1) {
    if (count[b]! < MIN_BIN_SAMPLES) continue;
    const value = sum[b]! / count[b]!;
    if (last < 0) for (let k = 0; k <= b; k += 1) curve[k] = value * (k / Math.max(1, b));
    else for (let k = last + 1; k <= b; k += 1) curve[k] = curve[last]! + ((value - curve[last]!) * (k - last)) / (b - last);
    curve[b] = value;
    last = b;
  }
  if (last < 0) return curve;

  const back = Math.max(0, last - 16);
  const slope = last > back ? (curve[last]! - curve[back]!) / ((last - back) / (BINS - 1)) : 1;
  for (let b = last + 1; b < BINS; b += 1) curve[b] = curve[last]! + (slope * (b - last)) / (BINS - 1);
  for (let b = 1; b < BINS; b += 1) if (curve[b]! < curve[b - 1]!) curve[b] = curve[b - 1]!;
  return curve;
}

function sampleCurve(curve: Float64Array, x: number): number {
  if (x <= 0) return 0;
  const t = Math.min(BINS - 1, (x / TRUST_CEILING) * (BINS - 1));
  const lo = Math.floor(t);
  if (lo >= BINS - 1) return curve[BINS - 1]!;
  return curve[lo]! * (1 - (t - lo)) + curve[lo + 1]! * (t - lo);
}

/**
 * The tone stage: the camera's per-channel rendering below diffuse white, and one
 * shared gain above it.
 *
 * Above the ceiling the whole pixel is scaled down until its brightest channel
 * sits at the top of the fit domain, read there, and scaled back up by the same
 * factor. So a bright orange keeps the camera's orange and only gets brighter.
 *
 * Letting each channel run on its own extrapolation instead is what tinted the
 * sky magenta: the three end slopes came out 0.435 / 0.206 / 0.336, so red and
 * blue climbed at twice green's rate and the drift grew with brightness.
 */
function tone(colour: HdrColour, r: number, g: number, b: number): [number, number, number] {
  const s = Math.max(1, Math.max(r, g, b) / TRUST_CEILING);
  return [
    sampleCurve(colour.curves[0], r / s) * s,
    sampleCurve(colour.curves[1], g / s) * s,
    sampleCurve(colour.curves[2], b / s) * s,
  ];
}

/**
 * The tone stage for one channel, valid only while every channel of the pixel is
 * below the ceiling - which is where the shared gain is 1 and the stage is
 * separable. That is almost every pixel, so a caller grading a 60MP frame can
 * build a lookup from this and take the general path only for the highlights.
 */
export function toneChannel(colour: HdrColour, channel: number, x: number): number {
  return sampleCurve(colour.curves[channel]!, x);
}

/** Everything after the tone stage: the matrix, then the chroma blend. */
export function finishColour(colour: HdrColour, r: number, g: number, b: number): [number, number, number] {
  const [mr, mg, mb] = apply3(colour.matrix, r, g, b);
  if (colour.saturation === 1) return [mr, mg, mb];
  const l = LUMA[0] * mr + LUMA[1] * mg + LUMA[2] * mb;
  return [l + (mr - l) * colour.saturation, l + (mg - l) * colour.saturation, l + (mb - l) * colour.saturation];
}

/**
 * The camera's transform for one scene-linear pixel, normalised so 1.0 is diffuse
 * white on the way in and on the way out.
 */
/** The tone stage alone, for a caller that does the rest itself. */
export function applyToneStage(colour: HdrColour, r: number, g: number, b: number): [number, number, number] {
  return tone(colour, r, g, b);
}

export function applyHdrColour(colour: HdrColour, r: number, g: number, b: number): [number, number, number] {
  const v = tone(colour, r, g, b);
  return finishColour(colour, v[0], v[1], v[2]);
}

/** Gauss-Jordan on a 3x3, returning null rather than garbage when singular. */
function solveRow(matrix: number[][], rhs: number[]): number[] | null {
  const m = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    if (Math.abs(m[col]![col]!) < 1e-12) return null;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = m[row]![col]! / m[col]![col]!;
      for (let k = col; k <= 3; k += 1) m[row]![k]! -= factor * m[col]![k]!;
    }
  }
  return [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!);
}

const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// A nudge towards identity, which costs nothing where the data is strong and
// keeps the matrix from inventing a cross-channel term out of whatever the frame
// happens not to contain.
const MATRIX_RIDGE = 0.05;

function fitColour(render: Plane, jpeg: Plane): HdrColour | null {
  const bits = mask(render, jpeg);
  let all = 0;
  for (const v of bits) if (v & ALL) all += 1;
  if (all < MIN_PAIRS) return null;

  const curves = [0, 1, 2].map((c) => {
    const xs = new Float64Array(bits.length);
    const ys = new Float64Array(bits.length);
    let k = 0;
    for (let p = 0; p < bits.length; p += 1) {
      if (!(bits[p]! & (1 << c))) continue;
      xs[k] = render.data[p * 3 + c]!;
      ys[k] = jpeg.data[p * 3 + c]!;
      k += 1;
    }
    return fitCurve(xs, ys, k);
  }) as [Float64Array, Float64Array, Float64Array];

  const colour: HdrColour = { curves, matrix: IDENTITY, saturation: 1, deltaE: Number.POSITIVE_INFINITY };

  // Weighted least squares, and the weighting is not a detail. Unweighted in
  // linear light the brightest pixels dominate - on a frame that is half sky, the
  // sky *is* the fit - and the matrix it lands on oversaturates everything
  // darker: measured at 1.093x the camera's mean chroma, which reads exactly as
  // "slightly too saturated". The weight is d(cbrt)/dv, so a sample counts for
  // its perceptual size rather than its photometric one.
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let p = 0; p < bits.length; p += 1) {
    if (!(bits[p]! & ALL)) continue;
    const i = p * 3;
    const v = tone(colour, render.data[i]!, render.data[i + 1]!, render.data[i + 2]!);
    const w = 1 / (Math.cbrt(luma(jpeg.data, i)) ** 2 + 1e-3);
    for (let a = 0; a < 3; a += 1) {
      for (let b = 0; b < 3; b += 1) ata[a]![b]! += w * v[a]! * v[b]!;
      for (let o = 0; o < 3; o += 1) atb[o]![a]! += w * v[a]! * jpeg.data[i + o]!;
    }
  }
  const scale = ata[0]![0]! + ata[1]![1]! + ata[2]![2]!;
  for (let i = 0; i < 3; i += 1) {
    ata[i]![i]! += MATRIX_RIDGE * scale;
    atb[i]![i]! += MATRIX_RIDGE * scale;
  }
  colour.matrix = [0, 1, 2].map((o) => solveRow(ata.map((row) => [...row]), atb[o]!) ?? IDENTITY[o]!);

  // One scalar on top, because a 3x3 cannot express a saturation that varies with
  // level and the camera's does: the weighting above takes the excess chroma from
  // 9.3% to 4.2% and then stops. Chroma is linear in this blend, so it solves
  // rather than searches.
  const measured = measure(colour, render, jpeg, bits);
  colour.saturation = measured.chroma > 1e-6 ? 1 / measured.chroma : 1;
  colour.deltaE = measure(colour, render, jpeg, bits).deltaE;
  return colour;
}

// deltaE76 wants 8-bit sRGB, which is also the only space the two fits report in
// comparably. Values above diffuse white have nowhere to go in it, but the mask
// has already excluded those.
function toSrgb8(r: number, g: number, b: number): [number, number, number] {
  const oetf = (v: number): number => {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  // Back to sRGB primaries first; the fit works in Rec.2020.
  const m = multiply(
    [
      [3.2404542, -1.5371385, -0.4985314],
      [-0.969266, 1.8760108, 0.041556],
      [0.0556434, -0.2040259, 1.0572252],
    ],
    [
      [0.637958, 0.1446169, 0.168881],
      [0.2627002, 0.6779981, 0.0593017],
      [0.0, 0.0280727, 1.0609851],
    ],
  );
  const [sr, sg, sb] = apply3(m, r, g, b);
  return [oetf(sr), oetf(sg), oetf(sb)];
}

function measure(colour: HdrColour, render: Plane, jpeg: Plane, bits: Uint8Array): { deltaE: number; chroma: number } {
  let sum = 0;
  let ours = 0;
  let theirs = 0;
  let n = 0;
  for (let p = 0; p < bits.length; p += 1) {
    if (!(bits[p]! & ALL)) continue;
    const i = p * 3;
    const [r, g, b] = applyHdrColour(colour, render.data[i]!, render.data[i + 1]!, render.data[i + 2]!);
    sum += deltaE76(toSrgb8(r, g, b), toSrgb8(jpeg.data[i]!, jpeg.data[i + 1]!, jpeg.data[i + 2]!));
    const ourL = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
    const theirL = luma(jpeg.data, i);
    ours += Math.hypot(r - ourL, g - ourL, b - ourL);
    theirs += Math.hypot(jpeg.data[i]! - theirL, jpeg.data[i + 1]! - theirL, jpeg.data[i + 2]! - theirL);
    n += 1;
  }
  return { deltaE: sum / Math.max(1, n), chroma: ours / Math.max(1e-9, theirs) };
}

// ------------------------------------------------------------------- the entry

/**
 * Fits the camera's colour treatment in the HDR grade's own domain, reusing the
 * geometry the SDR fit already resolved.
 *
 * `anchor` is diffuse white as a raw 16-bit level, which the grade measures the
 * same way (§10.7.1); the fit is done in multiples of it so the curve means the
 * same thing whatever the exposure. Returns null when there are too few usable
 * pairs to fit from, in which case the caller grades untransformed.
 */
export async function fitHdrColour(
  linear: DecodedImage,
  anchor: number,
  jpegBytes: Buffer,
  geometry: Pick<MatchProfile, 'distortion' | 'crop'>,
): Promise<HdrColour | null> {
  if (linear.depth !== 16) throw new Error(`fitHdrColour needs a 16-bit decode, got ${linear.depth}`);
  if (!(anchor > 0)) return null;

  // The embedded JPEG carries its own EXIF orientation, unlike a render, which
  // the decoder has already baked upright (§10.3).
  const decoded = await sharp(jpegBytes)
    .rotate()
    .resize(FIT_LONG_EDGE, FIT_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Linearised before the resample: averaging gamma-encoded samples is not
  // averaging light, and at this scale factor that alone shifts the mid-tones.
  const full = new Float64Array(decoded.info.width * decoded.info.height * 3);
  for (let p = 0; p < decoded.info.width * decoded.info.height; p += 1) {
    const i = p * 3;
    const [r, g, b] = apply3(
      SRGB_TO_REC2020,
      SRGB_EOTF[decoded.data[i]!]!,
      SRGB_EOTF[decoded.data[i + 1]!]!,
      SRGB_EOTF[decoded.data[i + 2]!]!,
    );
    full[i] = r;
    full[i + 1] = g;
    full[i + 2] = b;
  }
  const jpeg: Plane = { width: decoded.info.width, height: decoded.info.height, data: full };
  blurPlane(jpeg, FIT_BLUR_RADIUS);

  // Down to twice the fit grid *before* warping, the same order `jpeg_match.ts`
  // uses. Warping 60MP with bilinear taps and resampling afterwards is both
  // slower and worse: it aliases going in, and it blurs the geometry going out.
  // Measured, warping at full resolution took the fit from under a second to 17.
  const source = samples(linear);
  const wide = Math.min(linear.width, jpeg.width * 2);
  const tall = Math.max(1, Math.round((linear.height / linear.width) * wide));
  const scaled = new Float64Array(source.length);
  for (let i = 0; i < scaled.length; i += 1) scaled[i] = source[i]! / anchor;
  const small = resample(scaled, linear.width, linear.height, wide, tall);

  // Through the same geometry the SDR fit resolved, so a pair is two views of one
  // point in the scene.
  const warped = geometry.distortion
    ? warp({ width: wide, height: tall, data: small }, wide, tall, geometry.distortion, geometry.crop)
    : { width: wide, height: tall, data: small };

  const render: Plane = {
    width: jpeg.width,
    height: jpeg.height,
    data: resample(warped.data, warped.width, warped.height, jpeg.width, jpeg.height),
  };
  blurPlane(render, FIT_BLUR_RADIUS);

  return fitColour(render, jpeg);
}

function samples(image: DecodedImage): Uint16Array {
  return new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2);
}

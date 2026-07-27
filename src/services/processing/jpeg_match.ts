// Deriving, per photo, the transform that makes a RAW render look like the
// camera's own JPEG - the maker's colour treatment and whichever picture profile
// the photographer had set, without hosting any profile of our own.
//
// Order matters and is not negotiable: geometry first, colour second. A colour
// transform is fitted from pixel pairs, and a pair means nothing unless both
// pixels show the same point in the scene. On a frame whose JPEG is
// distortion-corrected, fitting colour first plateaus at deltaE 16 no matter how
// much capacity the colour model is given - including a 33^3 LUT - because no tone
// curve can map a pixel onto a different pixel's colour.
//
// Geometry comes from the camera where it recorded it (`lens_corrections.ts`) and
// is fitted here otherwise, which is the common case: 14 of 20 Sony bodies
// measured record nothing. Colour is always fitted, since nothing in the file
// describes the picture profile.

import sharp from 'sharp';
import { polynomialKnots, readDistortionSpline, sampleRadius, SPLINE_UNIT } from './lens_corrections';
import { decodeRaw, readEmbeddedJpeg, type DecodedImage } from './raw_decoder';

// Long edge the fit runs at. Fitting small and applying at full resolution costs
// nothing measurable (deltaE 1.40 against 1.42) and every candidate warp is
// O(pixels), so this is the single biggest lever on how long a fit takes: it is
// paid once per candidate, and there are tens of candidates. 640 still leaves well
// over a hundred thousand usable pairs, far more than 256-bin curves need.
const FIT_LONG_EDGE = 640;

// Both images are blurred before pairing. The camera's sharpening and noise
// reduction are not reproducible and must not leak into the colour fit, and a
// little residual misregistration stops mattering once neither image has detail at
// that scale. Only the fit sees this; the output never does.
const FIT_BLUR_SIGMA = 3;

// A pair from a steep gradient is worthless: a fraction of a pixel of
// misalignment there swamps the colour difference being measured.
const MAX_PAIR_GRADIENT = 24;

const MIN_PAIRS = 2000;

/** Beyond this the match is not trustworthy, so the render ships untransformed. */
export const MAX_ACCEPTABLE_DELTA_E = 6;

export interface ColourTransform {
  /** Per-channel tone curves, 256 entries each, indexed by 8-bit input. */
  curves: [Uint8Array, Uint8Array, Uint8Array];
  /** Applied after the curves; row-major, output channel by input channel. */
  matrix: number[][];
}

export interface MatchProfile {
  /** Radial knots in `SPLINE_UNIT`s, or null when no correction is needed. */
  distortion: number[] | null;
  /** Overall rescale accompanying the distortion. */
  crop: number;
  /** Where the geometry came from, for reporting and for cache keys. */
  distortionSource: 'camera' | 'fitted' | 'none';
  colour: ColourTransform;
  /** Held-out mean deltaE76 after the whole transform. */
  deltaE: number;
}

interface Plane {
  width: number;
  height: number;
  data: Buffer; // interleaved RGB8
}

type ArrayConstructorOf<T> = new (length: number) => T;

interface Pair {
  src: [number, number, number];
  dst: [number, number, number];
}

function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// ---------------------------------------------------------------- image plumbing

async function embeddedOnFitGrid(jpegBytes: Buffer): Promise<Plane> {
  // The embedded JPEG carries its own EXIF orientation, unlike a render, which the
  // decoder has already baked upright (DESIGN §10.3).
  const out = await sharp(jpegBytes)
    .rotate()
    .resize(FIT_LONG_EDGE, FIT_LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
    .blur(FIT_BLUR_SIGMA)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: out.info.width, height: out.info.height, data: out.data };
}

/**
 * The render at twice the fit grid, so the warp resamples from prefiltered pixels.
 * Warping straight from 60MP with bilinear taps would alias; resizing after the
 * warp would blur the geometry being measured.
 */
async function renderSource(image: DecodedImage, fitWidth: number): Promise<Plane> {
  const width = fitWidth * 2;
  const height = Math.max(1, Math.round((image.height / image.width) * width));
  const data = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  return { width, height, data };
}

/**
 * Bilinear resample of `source` onto a `width`x`height` grid through a radial
 * model.
 *
 * Generic over the sample width so the HDR fit can put a 16-bit scene-linear
 * frame through the same geometry (§10.8): the arithmetic is identical, only the
 * container differs, and two copies of a warp is two places for a sign to be
 * wrong in.
 */
export function warp<T extends Uint8Array | Uint16Array | Float64Array>(
  source: { width: number; height: number; data: T },
  width: number,
  height: number,
  knots: readonly number[],
  crop: number,
): { width: number; height: number; data: T } {
  const count = width * height * 3;
  // Not `new source.data.constructor(...)`: for the SDR path that is `Buffer`,
  // whose constructor is deprecated and refuses to allocate.
  const out = (
    Buffer.isBuffer(source.data) ? Buffer.allocUnsafe(count) : new (source.data.constructor as ArrayConstructorOf<T>)(count)
  ) as T;
  const half = Math.hypot(width / 2, height / 2);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const dy = (y - height / 2) / half;
    for (let x = 0; x < width; x += 1) {
      const dx = (x - width / 2) / half;
      const radius = Math.hypot(dx, dy);
      // sampleRadius returns a radius; the direction is unchanged, so scale the
      // components by the ratio rather than recomputing an angle.
      const ratio = radius === 0 ? crop : sampleRadius(knots, radius, crop) / radius;
      const px = source.width / 2 + dx * ratio * half * scaleX;
      const py = source.height / 2 + dy * ratio * half * scaleY;
      const o = (y * width + x) * 3;
      if (px < 0 || py < 0 || px >= source.width - 1 || py >= source.height - 1) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        continue;
      }
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const i00 = (y0 * source.width + x0) * 3;
      const i01 = i00 + source.width * 3;
      for (let c = 0; c < 3; c += 1) {
        out[o + c] =
          source.data[i00 + c]! * (1 - fx) * (1 - fy) +
          source.data[i00 + 3 + c]! * fx * (1 - fy) +
          source.data[i01 + c]! * (1 - fx) * fy +
          source.data[i01 + 3 + c]! * fx * fy;
      }
    }
  }
  return { width, height, data: out };
}

async function blur(plane: Plane, sigma: number): Promise<Plane> {
  const data = await sharp(plane.data, { raw: { width: plane.width, height: plane.height, channels: 3 } })
    .blur(sigma)
    .raw()
    .toBuffer();
  return { ...plane, data };
}

// ------------------------------------------------------------------ colour model

function pairs(render: Plane, jpeg: Plane): Pair[] {
  const { width, height } = jpeg;
  const out: Pair[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 3;
      const src: [number, number, number] = [render.data[i]!, render.data[i + 1]!, render.data[i + 2]!];
      const dst: [number, number, number] = [jpeg.data[i]!, jpeg.data[i + 1]!, jpeg.data[i + 2]!];
      // Clipped samples carry no mapping: everything above the knee landed on the
      // same value, so they would drag the top of the curve down.
      if (Math.min(...dst) <= 2 || Math.max(...dst) >= 253) continue;
      if (Math.min(...src) <= 1 || Math.max(...src) >= 254) continue;
      const gx = Math.abs(jpeg.data[i + 3]! - jpeg.data[i - 3]!);
      const gy = Math.abs(jpeg.data[i + width * 3]! - jpeg.data[i - width * 3]!);
      if (gx + gy > MAX_PAIR_GRADIENT) continue;
      // A black warp margin is not scene content.
      if (src[0] === 0 && src[1] === 0 && src[2] === 0) continue;
      out.push({ src, dst });
    }
  }
  return out;
}

const MIN_BIN_SAMPLES = 8;

/**
 * One channel's tone curve, as the mean target for each input level. Gaps are
 * interpolated, the ends extend at the last known slope rather than flattening
 * (which would crush every highlight the frame happened not to sample), and the
 * result is made monotone so a thinly-populated bin cannot invert it.
 */
function fitCurve(train: readonly Pair[], channel: number): Uint8Array {
  const sum = new Float64Array(256);
  const count = new Float64Array(256);
  for (const pair of train) {
    const level = pair.src[channel]!;
    sum[level]! += pair.dst[channel]!;
    count[level]! += 1;
  }

  const curve = new Float64Array(256).fill(Number.NaN);
  for (let level = 0; level < 256; level += 1) {
    if (count[level]! >= MIN_BIN_SAMPLES) curve[level] = sum[level]! / count[level]!;
  }
  const known: number[] = [];
  for (let level = 0; level < 256; level += 1) if (Number.isFinite(curve[level]!)) known.push(level);
  if (known.length < 2) return Uint8Array.from({ length: 256 }, (_, level) => level);

  const first = known[0]!;
  const last = known[known.length - 1]!;
  const tailSlope = (curve[last]! - curve[known[known.length - 2]!]!) / (last - known[known.length - 2]!);
  let cursor = 0;
  for (let level = 0; level < 256; level += 1) {
    if (Number.isFinite(curve[level]!)) continue;
    if (level < first) {
      curve[level] = (curve[first]! * level) / Math.max(1, first);
      continue;
    }
    if (level > last) {
      curve[level] = curve[last]! + tailSlope * (level - last);
      continue;
    }
    while (cursor < known.length - 1 && known[cursor + 1]! < level) cursor += 1;
    const lo = known[cursor]!;
    const hi = known[cursor + 1]!;
    curve[level] = curve[lo]! + ((curve[hi]! - curve[lo]!) * (level - lo)) / (hi - lo);
  }

  const out = new Uint8Array(256);
  let ceiling = 0;
  for (let level = 0; level < 256; level += 1) {
    ceiling = Math.max(ceiling, curve[level]!);
    out[level] = Math.round(Math.min(255, ceiling));
  }
  return out;
}

/** Gauss-Jordan on a 3x3. Returns null rather than garbage when singular. */
function solve3(matrix: number[][], rhs: number[]): number[] | null {
  const m = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    if (Math.abs(m[col]![col]!) < 1e-9) return null;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = m[row]![col]! / m[col]![col]!;
      for (let k = col; k <= 3; k += 1) m[row]![k]! -= factor * m[col]![k]!;
    }
  }
  return [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!);
}

const IDENTITY_MATRIX = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * Per-channel curves then a 3x3 mix. Deliberately not a 3D LUT: measured against
 * one, 777 coefficients beat a 17^3 LUT and tie a 33^3 one (deltaE 1.14 against
 * 1.06 with 107k), because the vendor transform is close enough to separable that
 * the extra dimensions only fit noise in the cells a single frame never populates.
 */
function fitColour(train: readonly Pair[]): ColourTransform {
  const curves: [Uint8Array, Uint8Array, Uint8Array] = [fitCurve(train, 0), fitCurve(train, 1), fitCurve(train, 2)];
  const toned = (pair: Pair): [number, number, number] => [
    curves[0][pair.src[0]!]!,
    curves[1][pair.src[1]!]!,
    curves[2][pair.src[2]!]!,
  ];

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
  for (const pair of train) {
    const s = toned(pair);
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) ata[i]![j]! += s[i]! * s[j]!;
      for (let o = 0; o < 3; o += 1) atb[o]![i]! += s[i]! * pair.dst[o]!;
    }
  }
  const matrix = [0, 1, 2].map((o) => solve3(ata.map((row) => [...row]), atb[o]!) ?? IDENTITY_MATRIX[o]!);
  return { curves, matrix };
}

export function applyColour(transform: ColourTransform, rgb: readonly number[]): [number, number, number] {
  const { curves, matrix } = transform;
  const r = curves[0][clamp8(Math.round(rgb[0]!))]!;
  const g = curves[1][clamp8(Math.round(rgb[1]!))]!;
  const b = curves[2][clamp8(Math.round(rgb[2]!))]!;
  return [
    clamp8(matrix[0]![0]! * r + matrix[0]![1]! * g + matrix[0]![2]! * b),
    clamp8(matrix[1]![0]! * r + matrix[1]![1]! * g + matrix[1]![2]! * b),
    clamp8(matrix[2]![0]! * r + matrix[2]![1]! * g + matrix[2]![2]! * b),
  ];
}

// ------------------------------------------------------------------------ deltaE

function toLinear(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function toLab(rgb: readonly number[]): [number, number, number] {
  const r = toLinear(rgb[0]!);
  const g = toLinear(rgb[1]!);
  const b = toLinear(rgb[2]!);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fy = f(y);
  return [116 * fy - 16, 500 * (f(x) - fy), 200 * (fy - f(z))];
}

export function deltaE76(a: readonly number[], b: readonly number[]): number {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// ------------------------------------------------------------------------ fitting

/**
 * Mean deltaE of `transform` over pairs it was not fitted on. Every number this
 * module reports is held out: a curve with 256 free parameters will always look
 * better on its own training pairs.
 */
function score(test: readonly Pair[], transform: ColourTransform): number {
  if (test.length === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (const pair of test) total += deltaE76(applyColour(transform, pair.src), pair.dst);
  return total / test.length;
}

function partition(all: readonly Pair[]): { train: Pair[]; test: Pair[] } {
  const train: Pair[] = [];
  const test: Pair[] = [];
  for (let i = 0; i < all.length; i += 1) (i % 2 === 0 ? train : test).push(all[i]!);
  return { train, test };
}

/**
 * How well the pair corresponds under a candidate geometry, measured as the
 * residual a colour fit can still not explain.
 *
 * Using the colour residual as the geometry objective is what makes this robust: a
 * wrong warp cannot be rescued by any tone curve, so a good score means genuine
 * correspondence. Feature matching was tried first and produced confident wrong
 * answers on repetitive texture; this cannot, and it needs no band selection,
 * subpixel interpolation or outlier rejection. It also folds the acceptance gate
 * into the fit, since the number being minimised *is* the correspondence measure.
 */
async function residualFor(
  source: Plane,
  jpeg: Plane,
  knots: readonly number[],
  crop: number,
): Promise<{ deltaE: number; colour: ColourTransform } | null> {
  const warped = await blur(warp(source, jpeg.width, jpeg.height, knots, crop), FIT_BLUR_SIGMA);
  const all = pairs(warped, jpeg);
  if (all.length < MIN_PAIRS) return null;
  const { train, test } = partition(all);
  const colour = fitColour(train);
  return { deltaE: score(test, colour), colour };
}

interface Geometry {
  knots: number[] | null;
  crop: number;
  source: 'camera' | 'fitted' | 'none';
  deltaE: number;
  colour: ColourTransform;
}

/** Coarse scan then halving refine of a single scalar. */
async function fitCrop(
  source: Plane,
  jpeg: Plane,
  knots: readonly number[],
  coarse: readonly number[],
): Promise<{ crop: number; deltaE: number; colour: ColourTransform } | null> {
  let best: { crop: number; deltaE: number; colour: ColourTransform } | null = null;
  for (const crop of coarse) {
    const result = await residualFor(source, jpeg, knots, crop);
    if (result && (best == null || result.deltaE < best.deltaE)) best = { crop, ...result };
  }
  if (best == null) return null;
  let step = (coarse[1] ?? 1) - (coarse[0] ?? 0);
  while (step > 0.0005) {
    let improved = false;
    for (const sign of [1, -1]) {
      const crop: number = best.crop + sign * step;
      const result = await residualFor(source, jpeg, knots, crop);
      if (result && result.deltaE < best.deltaE - 0.002) {
        best = { crop, ...result };
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }
  return best;
}

/**
 * Where to start looking for the crop that accompanies a known spline.
 *
 * A pincushion correction pulls the corner inward, so the camera has to scale by
 * roughly the reciprocal of the corner displacement to keep the frame full - and
 * measured against a fitted crop that prediction was exact (1/(1 + 740/16384) =
 * 0.95679 against 0.9569 fitted). For barrel the camera is more conservative than
 * tightest-fill, so this is only a starting point, never the answer: a scan around
 * it still runs. It replaces a blind sweep of the whole plausible range, which was
 * most of the cost of a fit on a body that had already told us about its lens.
 */
function estimateCrop(knots: readonly number[]): number {
  const corner = knots[knots.length - 1] ?? 0;
  return corner > 0 ? 1 / (1 + corner / SPLINE_UNIT) : 1;
}

function scanAround(centre: number, step: number, count: number): number[] {
  return Array.from({ length: count * 2 + 1 }, (_, i) => centre + (i - count) * step);
}

// The fallback searches a coarse grid and then refines, because crop and k1 trade
// off against each other: the grid finds the right valley and the refine walks down
// it. Scanning k1 alone and refining only the crop lands on whichever grid value
// is nearest and stops, which is how a 3% injected distortion came back as 4%.
const FALLBACK_K1_SCAN = [-0.06, -0.04, -0.02, 0, 0.02, 0.04, 0.06];
// Three crop values rather than a sweep: crop and k1 lie along a diagonal valley,
// so the grid only has to land in the valley and the joint refine walks down it.
const FALLBACK_CROP_SCAN = [0.97, 1.0, 1.03];
const REFINE_FLOOR = 0.0005;
const REFINE_MARGIN = 0.002;

interface Candidate {
  k1: number;
  crop: number;
  deltaE: number;
  colour: ColourTransform;
}

/**
 * Radial polynomial plus crop, for bodies that recorded no correction - the common
 * case. Two parameters reach the same residual as a camera's own spline (1.70
 * against 1.69 on the frame with the largest correction measured), so this is
 * slower than reading metadata but not less accurate.
 */
async function fitPolynomial(source: Plane, jpeg: Plane): Promise<Candidate | null> {
  let best: Candidate | null = null;
  for (const k1 of FALLBACK_K1_SCAN) {
    for (const crop of FALLBACK_CROP_SCAN) {
      const result = await residualFor(source, jpeg, polynomialKnots(k1, 0), crop);
      if (result && (best == null || result.deltaE < best.deltaE)) best = { k1, crop, ...result };
    }
  }
  if (best == null) return null;

  const steps = { k1: 0.01, crop: 0.01 };
  while (steps.crop > REFINE_FLOOR) {
    let improved = false;
    for (const key of ['k1', 'crop'] as const) {
      for (const sign of [1, -1]) {
        const k1: number = key === 'k1' ? best.k1 + sign * steps.k1 : best.k1;
        const crop: number = key === 'crop' ? best.crop + sign * steps.crop : best.crop;
        const result = await residualFor(source, jpeg, polynomialKnots(k1, 0), crop);
        if (result && result.deltaE < best.deltaE - REFINE_MARGIN) {
          best = { k1, crop, ...result };
          improved = true;
        }
      }
    }
    if (improved) continue;
    steps.k1 /= 2;
    steps.crop /= 2;
  }
  return best;
}

async function resolveGeometry(source: Plane, jpeg: Plane, rawBytes: Uint8Array): Promise<Geometry> {
  const identity = await residualFor(source, jpeg, [], 1);
  const baseline: Geometry = {
    knots: null,
    crop: 1,
    source: 'none',
    deltaE: identity?.deltaE ?? Number.POSITIVE_INFINITY,
    colour: identity?.colour ?? { curves: [fitCurve([], 0), fitCurve([], 1), fitCurve([], 2)], matrix: IDENTITY_MATRIX },
  };

  const cameraKnots = readDistortionSpline(rawBytes);
  if (cameraKnots) {
    const fitted = await fitCrop(source, jpeg, cameraKnots, scanAround(estimateCrop(cameraKnots), 0.01, 3));
    // The camera's curve is the truth about the lens, but only if using it
    // actually corresponds better - a body whose preview is uncorrected records
    // the spline anyway.
    if (fitted && fitted.deltaE < baseline.deltaE) {
      return { knots: cameraKnots, crop: fitted.crop, source: 'camera', deltaE: fitted.deltaE, colour: fitted.colour };
    }
    return baseline;
  }

  const fitted = await fitPolynomial(source, jpeg);
  if (fitted == null || fitted.deltaE >= baseline.deltaE) return baseline;
  return {
    knots: polynomialKnots(fitted.k1, 0),
    crop: fitted.crop,
    source: 'fitted',
    deltaE: fitted.deltaE,
    colour: fitted.colour,
  };
}

/**
 * Fits the transform that takes a render of `rawFilePath` to its embedded JPEG.
 * Null when the file has no embedded JPEG to match, or when the best match is
 * still too far off to be worth applying - in which case the caller renders
 * untransformed rather than shipping a bad grade.
 */
/**
 * `render` is the caller's own 8-bit sRGB decode of the same file. Pass it
 * whenever one is already in hand: decoding a 60MP frame costs about two seconds,
 * which is a large share of the whole fit, and doing it again here would be for an
 * identical result.
 */
export async function fitMatchProfile(rawFilePath: string, render?: DecodedImage): Promise<MatchProfile | null> {
  const jpegBytes = readEmbeddedJpeg(rawFilePath);
  if (!jpegBytes) return null;
  const rawBytes = new Uint8Array(await Bun.file(rawFilePath).arrayBuffer());
  return fitProfileFor(render ?? decodeRaw(rawFilePath, 8, 'srgb'), jpegBytes, rawBytes);
}

/**
 * The fit itself, separated from reading the file so a test can hand it a target
 * it constructed. `rawBytes` supplies the camera's recorded correction; pass an
 * empty array to exercise the fitted fallback.
 */
export async function fitProfileFor(
  render: DecodedImage,
  jpegBytes: Buffer,
  rawBytes: Uint8Array,
): Promise<MatchProfile | null> {
  const jpeg = await embeddedOnFitGrid(jpegBytes);
  const source = await renderSource(render, jpeg.width);

  const geometry = await resolveGeometry(source, jpeg, rawBytes);
  if (!Number.isFinite(geometry.deltaE) || geometry.deltaE > MAX_ACCEPTABLE_DELTA_E) return null;
  return {
    distortion: geometry.knots,
    crop: geometry.crop,
    distortionSource: geometry.source,
    colour: geometry.colour,
    deltaE: geometry.deltaE,
  };
}

/** Applies a fitted profile to a decoded render, in place of the render itself. */
export async function applyMatchProfile(image: DecodedImage, profile: MatchProfile): Promise<DecodedImage> {
  if (image.depth !== 8) throw new Error(`applyMatchProfile needs an 8-bit render, got ${image.depth}`);

  let data = image.data;
  let { width, height } = image;
  if (profile.distortion) {
    const warped = warp({ width, height, data }, width, height, profile.distortion, profile.crop);
    data = warped.data;
    width = warped.width;
    height = warped.height;
  }

  const out = Buffer.allocUnsafe(data.length);
  const { curves, matrix } = profile.colour;
  for (let i = 0; i < data.length; i += 3) {
    const r = curves[0][data[i]!]!;
    const g = curves[1][data[i + 1]!]!;
    const b = curves[2][data[i + 2]!]!;
    out[i] = clamp8(matrix[0]![0]! * r + matrix[0]![1]! * g + matrix[0]![2]! * b);
    out[i + 1] = clamp8(matrix[1]![0]! * r + matrix[1]![1]! * g + matrix[1]![2]! * b);
    out[i + 2] = clamp8(matrix[2]![0]! * r + matrix[2]![1]! * g + matrix[2]![2]! * b);
  }
  return { width, height, channels: 3, depth: 8, data: out };
}

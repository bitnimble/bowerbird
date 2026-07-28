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

/**
 * Corresponding samples, six bytes each: source RGB then target RGB.
 *
 * Flat rather than an array of `{src, dst}` objects because this is the hot
 * structure of the whole fit - a candidate geometry produces ~180k of them, and
 * every candidate rebuilds the set. Measured on a 61MP frame, allocating three
 * objects per pair cost 41ms per candidate against 1.8ms for filling one buffer,
 * and a like-for-like Rust port of the object version only reached 1.4ms: the
 * allocation was the whole gap, not the language.
 */
interface Pairs {
  /** Six bytes per pair: src R,G,B then dst R,G,B. */
  data: Uint8Array;
  count: number;
}

const PAIR_STRIDE = 6;

// Which half of the pairs a pass reads. Alternating by index rather than copying
// the set in two keeps the train/test split free, and it is the same split the
// object version made.
const TRAIN = 0;
const TEST = 1;
type Phase = typeof TRAIN | typeof TEST;

function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

// ---------------------------------------------------------------- image plumbing

async function embeddedOnFitGrid(jpegBytes: Buffer, longEdge: number): Promise<Plane> {
  // The embedded JPEG carries its own EXIF orientation, unlike a render, which the
  // decoder has already baked upright (DESIGN §10.3).
  const out = await sharp(jpegBytes)
    .rotate()
    .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .blur(FIT_BLUR_SIGMA)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: out.info.width, height: out.info.height, data: out.data };
}

/** The render and the camera's JPEG on one common grid, ready to be compared. */
interface Grid {
  source: Plane;
  jpeg: Plane;
}

/** Both resolutions a fit works at: cheap for scanning, full for refining. */
interface Grids {
  full: Grid;
  search: Grid;
}

async function gridAt(render: DecodedImage, jpegBytes: Buffer, longEdge: number): Promise<Grid> {
  const jpeg = await embeddedOnFitGrid(jpegBytes, longEdge);
  return { jpeg, source: await renderSource(render, jpeg.width) };
}

async function halve(plane: Plane): Promise<Plane> {
  const width = Math.max(1, Math.round(plane.width / 2));
  const height = Math.max(1, Math.round(plane.height / 2));
  const data = await sharp(plane.data, { raw: { width: plane.width, height: plane.height, channels: 3 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  return { width, height, data };
}

/**
 * Half-size copy of the grid, for ranking candidates.
 *
 * The search only has to order geometries against each other, and that ordering is
 * a smooth function of two parameters - it does not need the resolution the final
 * transform is fitted at. Half the long edge is a quarter of the pixels through
 * every stage of every candidate, and the winner is re-fitted at full size, so
 * nothing that ships was measured here.
 *
 * Derived from the full grid rather than built from the 60MP decode a second time:
 * resizing a 1280px plane costs nothing, resizing the original costs ~250ms, and
 * doing that twice ate most of what the coarse search saved.
 */
async function searchGrid(full: Grid): Promise<Grid> {
  const [source, jpeg] = await Promise.all([halve(full.source), halve(full.jpeg)]);
  return { source, jpeg };
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
// Entries in the radius lookup the warp indexes by r^2. Radii are normalised to
// the half-diagonal, so r^2 runs exactly 0..1 over the frame and the table needs
// no range beyond that. 4096 buckets put the spline's own kinks several buckets
// apart on a 16-knot curve, and the residual interpolation error is far below the
// bilinear sampling that follows it.
const RATIO_TABLE_LAST = 4096;

/**
 * `sampleRadius(r) / r` sampled over r^2, which is the form the warp wants: it has
 * dx and dy, so it has r^2 for free, and turning that into a ratio via the table
 * skips the sqrt, the spline walk and the division that a direct evaluation needs
 * at every pixel.
 */
function ratioTable(knots: readonly number[], crop: number): Float64Array {
  const table = new Float64Array(RATIO_TABLE_LAST + 1);
  for (let slot = 0; slot <= RATIO_TABLE_LAST; slot += 1) {
    const radius = Math.sqrt(slot / RATIO_TABLE_LAST);
    // At the centre the ratio is the crop alone: the spline is anchored at zero
    // there, and dividing a zero radius by itself is not defined.
    table[slot] = radius === 0 ? crop : sampleRadius(knots, radius, crop) / radius;
  }
  return table;
}

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
  const ratios = ratioTable(knots, crop);
  const centreX = source.width / 2;
  const centreY = source.height / 2;
  const stepX = half * scaleX;
  const stepY = half * scaleY;
  const edgeX = source.width - 1;
  const edgeY = source.height - 1;
  for (let y = 0; y < height; y += 1) {
    const dy = (y - height / 2) / half;
    const dy2 = dy * dy;
    for (let x = 0; x < width; x += 1) {
      const dx = (x - width / 2) / half;
      // Indexed by r^2, so the per-pixel work is a multiply and two loads: no
      // sqrt, no walk along the spline, and no divide to turn a radius back into
      // a ratio. Direction is unchanged by a radial model, so scaling the
      // components by the ratio is the whole transform.
      const t = (dx * dx + dy2) * RATIO_TABLE_LAST;
      const slot = t < RATIO_TABLE_LAST ? t | 0 : RATIO_TABLE_LAST - 1;
      const low = ratios[slot]!;
      const ratio = low + (ratios[slot + 1]! - low) * (t - slot);
      const px = centreX + dx * ratio * stepX;
      const py = centreY + dy * ratio * stepY;
      const o = (y * width + x) * 3;
      if (px < 0 || py < 0 || px >= edgeX || py >= edgeY) {
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

function pairs(render: Plane, jpeg: Plane): Pairs {
  const { width, height } = jpeg;
  const data = new Uint8Array(width * height * PAIR_STRIDE);
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 3;
      const s0 = render.data[i]!;
      const s1 = render.data[i + 1]!;
      const s2 = render.data[i + 2]!;
      const d0 = jpeg.data[i]!;
      const d1 = jpeg.data[i + 1]!;
      const d2 = jpeg.data[i + 2]!;
      // Clipped samples carry no mapping: everything above the knee landed on the
      // same value, so they would drag the top of the curve down.
      if (Math.min(d0, d1, d2) <= 2 || Math.max(d0, d1, d2) >= 253) continue;
      if (Math.min(s0, s1, s2) <= 1 || Math.max(s0, s1, s2) >= 254) continue;
      const gx = Math.abs(jpeg.data[i + 3]! - jpeg.data[i - 3]!);
      const gy = Math.abs(jpeg.data[i + width * 3]! - jpeg.data[i - width * 3]!);
      if (gx + gy > MAX_PAIR_GRADIENT) continue;
      // A black warp margin is not scene content.
      if (s0 === 0 && s1 === 0 && s2 === 0) continue;
      const o = count * PAIR_STRIDE;
      data[o] = s0;
      data[o + 1] = s1;
      data[o + 2] = s2;
      data[o + 3] = d0;
      data[o + 4] = d1;
      data[o + 5] = d2;
      count += 1;
    }
  }
  return { data, count };
}

const MIN_BIN_SAMPLES = 8;

/**
 * One channel's tone curve, as the mean target for each input level. Gaps are
 * interpolated, the ends extend at the last known slope rather than flattening
 * (which would crush every highlight the frame happened not to sample), and the
 * result is made monotone so a thinly-populated bin cannot invert it.
 */
function fitCurve(pairs: Pairs, phase: Phase, channel: number): Uint8Array {
  const sum = new Float64Array(256);
  const count = new Float64Array(256);
  for (let p = phase; p < pairs.count; p += 2) {
    const o = p * PAIR_STRIDE;
    const level = pairs.data[o + channel]!;
    sum[level]! += pairs.data[o + 3 + channel]!;
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

/** Leaves a render exactly as it is, for when there were not enough pairs to fit. */
function identityTransform(): ColourTransform {
  const ramp = (): Uint8Array => Uint8Array.from({ length: 256 }, (_, level) => level);
  return { curves: [ramp(), ramp(), ramp()], matrix: IDENTITY_MATRIX };
}

/**
 * Per-channel curves then a 3x3 mix. Deliberately not a 3D LUT: measured against
 * one, 777 coefficients beat a 17^3 LUT and tie a 33^3 one (deltaE 1.14 against
 * 1.06 with 107k), because the vendor transform is close enough to separable that
 * the extra dimensions only fit noise in the cells a single frame never populates.
 */
function fitColour(pairs: Pairs, phase: Phase): ColourTransform {
  const curves: [Uint8Array, Uint8Array, Uint8Array] = [
    fitCurve(pairs, phase, 0),
    fitCurve(pairs, phase, 1),
    fitCurve(pairs, phase, 2),
  ];

  // Accumulated as scalars rather than through nested arrays: this is the inner
  // loop over every training pair, and the normal equations are only nine sums.
  let a00 = 0;
  let a01 = 0;
  let a02 = 0;
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  const b = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let p = phase; p < pairs.count; p += 2) {
    const o = p * PAIR_STRIDE;
    const s0 = curves[0][pairs.data[o]!]!;
    const s1 = curves[1][pairs.data[o + 1]!]!;
    const s2 = curves[2][pairs.data[o + 2]!]!;
    // A'A is symmetric, so only the upper triangle is accumulated.
    a00 += s0 * s0;
    a01 += s0 * s1;
    a02 += s0 * s2;
    a11 += s1 * s1;
    a12 += s1 * s2;
    a22 += s2 * s2;
    for (let out = 0; out < 3; out += 1) {
      const target = pairs.data[o + 3 + out]!;
      b[out]![0]! += s0 * target;
      b[out]![1]! += s1 * target;
      b[out]![2]! += s2 * target;
    }
  }
  const ata = [
    [a00, a01, a02],
    [a01, a11, a12],
    [a02, a12, a22],
  ];
  const matrix = [0, 1, 2].map((out) => solve3(ata.map((row) => [...row]), b[out]!) ?? IDENTITY_MATRIX[out]!);
  return { curves, matrix };
}

/**
 * The curves and the matrix collapsed into nine 256-entry tables, one per
 * (output channel, input channel) pair, so applying the transform to a pixel is
 * nine lookups and six adds rather than three lookups, nine multiplies and six
 * adds. Exact, not an approximation: the matrix is linear in each curve's output,
 * so folding the coefficient into the table changes nothing.
 *
 * Worth building even for a single rendition - a 3840px frame is 9.8M pixels.
 */
function foldTransform(transform: ColourTransform): Float64Array[] {
  const { curves, matrix } = transform;
  const folded: Float64Array[] = [];
  for (let out = 0; out < 3; out += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const table = new Float64Array(256);
      const coefficient = matrix[out]![channel]!;
      const curve = curves[channel]!;
      for (let level = 0; level < 256; level += 1) table[level] = coefficient * curve[level]!;
      folded.push(table);
    }
  }
  return folded;
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

// The scoring loop only ever linearises 8-bit levels, and the transfer's pow() is
// the most expensive arithmetic in the fit. 256 entries covers every input it can
// receive there.
const LINEAR_8BIT = new Float64Array(256);
for (let level = 0; level < 256; level += 1) LINEAR_8BIT[level] = toLinear(level);

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

/** Lab of three 8-bit levels, off the transfer lookup rather than three pow()s. */
function labFromLevels(r: number, g: number, b: number): [number, number, number] {
  const R = LINEAR_8BIT[r]!;
  const G = LINEAR_8BIT[g]!;
  const B = LINEAR_8BIT[b]!;
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fy = f(y);
  return [116 * fy - 16, 500 * (f(x) - fy), 200 * (fy - f(z))];
}

// ------------------------------------------------------------------------ fitting

/**
 * Mean deltaE of `transform` over pairs it was not fitted on. Every number this
 * module reports is held out: a curve with 256 free parameters will always look
 * better on its own training pairs.
 */
function score(pairs: Pairs, phase: Phase, transform: ColourTransform): number {
  const { curves, matrix } = transform;
  const m = matrix;
  let total = 0;
  let counted = 0;
  for (let p = phase; p < pairs.count; p += 2) {
    const o = p * PAIR_STRIDE;
    const r = curves[0][pairs.data[o]!]!;
    const g = curves[1][pairs.data[o + 1]!]!;
    const b = curves[2][pairs.data[o + 2]!]!;
    // Rounded to the level that would actually be written to the rendition, which
    // is also what makes the lookup exact rather than an approximation.
    const out0 = clamp8(Math.round(m[0]![0]! * r + m[0]![1]! * g + m[0]![2]! * b));
    const out1 = clamp8(Math.round(m[1]![0]! * r + m[1]![1]! * g + m[1]![2]! * b));
    const out2 = clamp8(Math.round(m[2]![0]! * r + m[2]![1]! * g + m[2]![2]! * b));
    const a = labFromLevels(out0, out1, out2);
    const t = labFromLevels(pairs.data[o + 3]!, pairs.data[o + 4]!, pairs.data[o + 5]!);
    const dL = a[0] - t[0];
    const da = a[1] - t[1];
    const db = a[2] - t[2];
    total += Math.sqrt(dL * dL + da * da + db * db);
    counted += 1;
  }
  return counted === 0 ? Number.POSITIVE_INFINITY : total / counted;
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
  grid: Grid,
  knots: readonly number[],
  crop: number,
): Promise<{ deltaE: number; colour: ColourTransform } | null> {
  const { source, jpeg } = grid;
  const warped = await blur(warp(source, jpeg.width, jpeg.height, knots, crop), FIT_BLUR_SIGMA);
  const all = pairs(warped, jpeg);
  if (all.count < MIN_PAIRS) return null;
  const colour = fitColour(all, TRAIN);
  return { deltaE: score(all, TEST, colour), colour };
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
  grids: Grids,
  knots: readonly number[],
  coarse: readonly number[],
): Promise<{ crop: number; deltaE: number } | null> {
  let best: { crop: number; deltaE: number } | null = null;
  for (const crop of coarse) {
    const result = await residualFor(grids.search, knots, crop);
    if (result && (best == null || result.deltaE < best.deltaE)) best = { crop, deltaE: result.deltaE };
  }
  if (best == null) return null;

  // Refine at full size. The scan only has to land in the right valley, which a
  // quarter of the pixels answers just as well, but the walk down it compares
  // neighbours a fraction of a percent apart - and at half resolution those
  // differences fall under the improvement threshold, so the refine stops early and
  // leaves the geometry short. Measured: an injected 3% distortion came back as
  // 1.3% when the refine also ran coarse.
  const rescored = await residualFor(grids.full, knots, best.crop);
  if (rescored) best = { crop: best.crop, deltaE: rescored.deltaE };
  let step = (coarse[1] ?? 1) - (coarse[0] ?? 0);
  while (step > REFINE_FLOOR) {
    let improved = false;
    for (const sign of [1, -1]) {
      const crop: number = best.crop + sign * step;
      const result = await residualFor(grids.full, knots, crop);
      if (result && result.deltaE < best.deltaE - REFINE_MARGIN) {
        best = { crop, deltaE: result.deltaE };
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
}

/**
 * Radial polynomial plus crop, for bodies that recorded no correction - the common
 * case. Two parameters reach the same residual as a camera's own spline (1.70
 * against 1.69 on the frame with the largest correction measured), so this is
 * slower than reading metadata but not less accurate.
 */
async function fitPolynomial(grids: Grids): Promise<Candidate | null> {
  let best: Candidate | null = null;
  for (const k1 of FALLBACK_K1_SCAN) {
    for (const crop of FALLBACK_CROP_SCAN) {
      const result = await residualFor(grids.search, polynomialKnots(k1, 0), crop);
      if (result && (best == null || result.deltaE < best.deltaE)) best = { k1, crop, deltaE: result.deltaE };
    }
  }
  if (best == null) return null;

  const rescored = await residualFor(grids.full, polynomialKnots(best.k1, 0), best.crop);
  if (rescored) best = { ...best, deltaE: rescored.deltaE };

  const steps = { k1: 0.01, crop: 0.01 };
  while (steps.crop > REFINE_FLOOR) {
    let improved = false;
    for (const key of ['k1', 'crop'] as const) {
      for (const sign of [1, -1]) {
        const k1: number = key === 'k1' ? best.k1 + sign * steps.k1 : best.k1;
        const crop: number = key === 'crop' ? best.crop + sign * steps.crop : best.crop;
        const result = await residualFor(grids.full, polynomialKnots(k1, 0), crop);
        if (result && result.deltaE < best.deltaE - REFINE_MARGIN) {
          best = { k1, crop, deltaE: result.deltaE };
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

interface Chosen {
  knots: number[] | null;
  crop: number;
  source: Geometry['source'];
  deltaE: number;
}

/**
 * Which geometry to use, decided entirely on the search grid. Every deltaE here is
 * for ranking candidates against each other; the winner is re-fitted at full size
 * by the caller, so none of these numbers is reported or shipped.
 */
async function chooseGeometry(grids: Grids, rawBytes: Uint8Array): Promise<Chosen> {
  const identity = await residualFor(grids.full, [], 1);
  const baseline: Chosen = { knots: null, crop: 1, source: 'none', deltaE: identity?.deltaE ?? Number.POSITIVE_INFINITY };

  const cameraKnots = readDistortionSpline(rawBytes);
  if (cameraKnots) {
    const fitted = await fitCrop(grids, cameraKnots, scanAround(estimateCrop(cameraKnots), 0.01, 3));
    // The camera's curve is the truth about the lens, but only if using it
    // actually corresponds better - a body whose preview is uncorrected records
    // the spline anyway.
    if (fitted && fitted.deltaE < baseline.deltaE) {
      return { knots: cameraKnots, crop: fitted.crop, source: 'camera', deltaE: fitted.deltaE };
    }
    return baseline;
  }

  const fitted = await fitPolynomial(grids);
  if (fitted == null || fitted.deltaE >= baseline.deltaE) return baseline;
  return { knots: polynomialKnots(fitted.k1, 0), crop: fitted.crop, source: 'fitted', deltaE: fitted.deltaE };
}

async function resolveGeometry(grids: Grids, rawBytes: Uint8Array): Promise<Geometry> {
  const chosen = await chooseGeometry(grids, rawBytes);
  // One evaluation at full size, for the transform that actually ships and the
  // deltaE that gets reported and gated on.
  const final = await residualFor(grids.full, chosen.knots ?? [], chosen.crop);
  return {
    knots: chosen.knots,
    crop: chosen.crop,
    source: chosen.source,
    deltaE: final?.deltaE ?? Number.POSITIVE_INFINITY,
    colour: final?.colour ?? identityTransform(),
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
  const full = await gridAt(render, jpegBytes, FIT_LONG_EDGE);
  const geometry = await resolveGeometry({ full, search: await searchGrid(full) }, rawBytes);
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
  // Hoisted out of the loop: reading these through profile.colour.matrix[o][c] per
  // pixel is nine property chains nine million times.
  const [rr, rg, rb, gr, gg, gb, br, bg, bb] = foldTransform(profile.colour) as [
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
    Float64Array,
  ];
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    out[i] = clamp8(rr[r]! + rg[g]! + rb[b]!);
    out[i + 1] = clamp8(gr[r]! + gg[g]! + gb[b]!);
    out[i + 2] = clamp8(br[r]! + bg[g]! + bb[b]!);
  }
  return { width, height, channels: 3, depth: 8, data: out };
}

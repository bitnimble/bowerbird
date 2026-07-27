import { applyHdrColour, applyToneStage, toneChannel, TRUST_CEILING, type HdrColour } from './hdr_match';
import type { DecodedImage } from './raw_decoder';

// Scene-referred sensor data carries no exposure. LibRaw scales sensor
// saturation to full range whatever the photographer metered, so declaring
// linear 1.0 to be the display's peak makes brightness a function of how the
// shot was exposed rather than of what was in front of the lens: measured over
// eight bodies, the same 1000-nit peak gave means from 33 to 321 nits, a 10x
// spread. Highlights also met the peak with no roll-off, so a clipped frame
// ended flat against it.
//
// Two ITU standards close that, and neither needs a look to be invented:
//   BT.2408  diffuse white in HDR sits at 203 nits, which is what makes HDR
//            read at the same brightness as the SDR beside it.
//   BT.2390  the EETF, a Hermite roll-off applied in PQ space, compressing
//            whatever is above the display's peak into it instead of clipping.
//
// The one judgement left is which sample counts as diffuse white, which no
// standard prescribes because a camera takes it from the metered exposure. A
// histogram quantile is the same heuristic dcraw's auto-bright uses, and is the
// knob worth tuning if a library renders consistently dark or hot.

const MAX = 65535;

// Rec.2020 luma, matching the chroma blend the match was fitted with.
const LUMA = [0.2627, 0.678, 0.0593] as const;

// SMPTE ST 2084.
const M1 = 2610 / 16384;
const M2 = (2523 / 4096) * 128;
const C1 = 3424 / 4096;
const C2 = (2413 / 4096) * 32;
const C3 = (2392 / 4096) * 32;
const PQ_MAX_NITS = 10000;

function pq(nits: number): number {
  const y = Math.min(1, Math.max(0, nits / PQ_MAX_NITS)) ** M1;
  return ((C1 + C2 * y) / (1 + C3 * y)) ** M2;
}

function pqInv(signal: number): number {
  const e = Math.min(1, Math.max(0, signal)) ** (1 / M2);
  return PQ_MAX_NITS * (Math.max(0, e - C1) / (C2 - C3 * e)) ** (1 / M1);
}

// ITU-R BT.2390-8 §5.4.1, with the black level at zero so the lift term drops
// out. Takes and returns nits.
function eetf(nits: number, sourcePeakNits: number, peakNits: number): number {
  const lw = pq(sourcePeakNits);
  const maxLum = pq(peakNits) / lw;
  // The source already fits the display, so there is nothing to compress.
  if (maxLum >= 1) return nits;
  // Only goes negative when the source is several stops brighter than the
  // display, and a negative knee would lift black, which the curve never means
  // to do.
  const ks = Math.max(0, 1.5 * maxLum - 0.5);
  const e1 = pq(nits) / lw;
  if (e1 < ks) return nits;

  const t = (e1 - ks) / (1 - ks);
  const t2 = t * t;
  const t3 = t2 * t;
  const e2 =
    (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * maxLum;
  return pqInv(e2 * lw);
}

// A quantile does not need every pixel of a 60MP frame.
const QUANTILE_STRIDE = 16;

// The brightest component of a pixel rather than its luminance, because that is
// what clips first: anchoring on luminance lets a saturated channel run past
// the top of the range while the pixel still reads as mid-toned.
//
// `peak` is the frame's own brightest sample and not sensor saturation, which is
// what makes the grade exposure-invariant: both levels scale with exposure, so
// their ratio - and therefore how much roll-off the highlights get - is a
// property of the scene. Reading the peak off the sensor instead would give a
// frame shot two stops down four times the compression for the same subject.
function levels(samples: Uint16Array, quantile: number): { white: number; peak: number } {
  const histogram = new Uint32Array(MAX + 1);
  let counted = 0;
  for (let i = 0; i + 2 < samples.length; i += 3 * QUANTILE_STRIDE) {
    const brightest = Math.max(samples[i]!, samples[i + 1]!, samples[i + 2]!);
    histogram[brightest]! += 1;
    counted += 1;
  }

  let peak = 0;
  let white = -1;
  let seen = 0;
  const target = counted * quantile;
  for (let level = 0; level <= MAX; level += 1) {
    const count = histogram[level]!;
    if (count === 0) continue;
    peak = level;
    seen += count;
    if (white < 0 && seen >= target) white = level;
  }
  return { white: white < 0 ? peak : white, peak };
}

export interface GradeOptions {
  /** Nits diffuse white maps to. 203 is BT.2408 HDR Reference White. */
  referenceWhiteNits: number;
  /** Display peak the roll-off targets. Equal to the reference for an SDR render. */
  peakNits: number;
  /** Quantile of the frame's brightest component taken as diffuse white. */
  whiteQuantile: number;
  /**
   * The camera's own colour treatment, fitted from its embedded JPEG (§10.8).
   * Omitted, the render keeps LibRaw's neutral rendering.
   */
  match?: HdrColour | null;
}

/** Where diffuse white sits in a decode, on its own so a fit can share it. */
export function diffuseWhite(image: DecodedImage, quantile: number): number {
  const source = new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2);
  return levels(source, quantile).white;
}

/**
 * Grades a scene-linear 16-bit decode to display-referred linear, where full
 * range is `peakNits` - which is what zscale's `npl` then ties to absolute
 * brightness. Returns a new image rather than grading in place: one decode
 * feeds several variants, and they do not share a target.
 */
export function grade(image: DecodedImage, options: GradeOptions): DecodedImage {
  if (image.depth !== 16) throw new Error(`grade needs a 16-bit decode, got ${image.depth}`);
  const source = new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2);

  const { white, peak: sourceLevel } = levels(source, options.whiteQuantile);
  // A frame with nothing in it has no exposure to read; leaving it alone beats
  // dividing by zero.
  if (white === 0) return image;

  const { referenceWhiteNits: reference, peakNits: peak, match } = options;
  const data = Buffer.allocUnsafe(image.data.byteLength);
  const out = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);

  // The roll-off is a function of nits alone, so it is a lookup whichever path
  // produced them. Resolution is in nits rather than input level because the
  // matched path has no single input level to key on.
  const ROLL_BINS = 4096;
  const roll = (nits: number, sourcePeakNits: number, table: Float64Array): number => {
    const t = (nits / sourcePeakNits) * (ROLL_BINS - 1);
    const lo = Math.min(ROLL_BINS - 2, Math.max(0, Math.floor(t)));
    return table[lo]! + (table[lo + 1]! - table[lo]!) * (t - lo);
  };

  if (match == null) {
    const sourcePeakNits = (sourceLevel / white) * reference;
    // One curve covers all 65536 possible inputs, so the per-sample work is a
    // lookup. A 60MP frame is 180M samples, and pow() that many times is not free.
    const lut = new Uint16Array(MAX + 1);
    for (let level = 0; level <= MAX; level += 1) {
      const nits = eetf((level / white) * reference, sourcePeakNits, peak);
      lut[level] = Math.round(Math.min(1, nits / peak) * MAX);
    }
    for (let i = 0; i < source.length; i += 1) out[i] = lut[source[i]!]!;
    return { ...image, data };
  }

  // Matched: the transform is cross-channel, so there is no per-input-level table
  // to build and the scene peak has to be measured after it rather than read off
  // the input's histogram.
  //
  // The peak comes from the same subsample the anchor does. Keeping every pixel's
  // nits to find the exact maximum wanted a Float32Array the size of the frame -
  // 720MB on a 60MP photo - to save clamping a handful of specular samples that
  // the roll-off was compressing into the peak anyway.
  let scenePeak = 0;
  for (let i = 0; i + 2 < source.length; i += 3 * QUANTILE_STRIDE) {
    const [r, g, b] = applyHdrColour(match, source[i]! / white, source[i + 1]! / white, source[i + 2]! / white);
    scenePeak = Math.max(scenePeak, r, g, b);
  }
  scenePeak *= reference;
  if (!(scenePeak > 0)) return image;

  const table = new Float64Array(ROLL_BINS);
  for (let i = 0; i < ROLL_BINS; i += 1) table[i] = eetf((i / (ROLL_BINS - 1)) * scenePeak, scenePeak, peak);

  // Below the ceiling the shared gain is 1 and the tone stage is separable, so it
  // is a lookup on the input level. That is nearly every pixel of a photograph;
  // only the highlights take the general path, where the gain depends on all
  // three channels at once. Interpolating a curve per channel per pixel instead
  // cost about seven seconds on a 60MP frame, twice per HDR rendition.
  const ceiling = TRUST_CEILING * white;
  const curveLut = [0, 1, 2].map((c) => {
    const lut = new Float32Array(MAX + 1);
    for (let level = 0; level <= MAX; level += 1) lut[level] = toneChannel(match, c, level / white);
    return lut;
  });

  // Flat and scalar on purpose. Written with the tuple-returning helpers it was
  // three array allocations per pixel, 180M on a 60MP frame, and the collector
  // cost more than all the arithmetic put together - the lookup above bought
  // almost nothing until this went with it.
  const m = match.matrix;
  const [m00, m01, m02] = [m[0]![0]!, m[0]![1]!, m[0]![2]!];
  const [m10, m11, m12] = [m[1]![0]!, m[1]![1]!, m[1]![2]!];
  const [m20, m21, m22] = [m[2]![0]!, m[2]![1]!, m[2]![2]!];
  const sat = match.saturation;
  const [lr, lg, lb] = LUMA;
  const [lutR, lutG, lutB] = curveLut as [Float32Array, Float32Array, Float32Array];
  const scale = (ROLL_BINS - 1) / scenePeak;

  for (let i = 0; i + 2 < source.length; i += 3) {
    const r = source[i]!;
    const g = source[i + 1]!;
    const b = source[i + 2]!;

    let tr: number;
    let tg: number;
    let tb: number;
    if (r <= ceiling && g <= ceiling && b <= ceiling) {
      tr = lutR[r]!;
      tg = lutG[g]!;
      tb = lutB[b]!;
    } else {
      const t = applyToneStage(match, r / white, g / white, b / white);
      tr = t[0];
      tg = t[1];
      tb = t[2];
    }

    let or = m00 * tr + m01 * tg + m02 * tb;
    let og = m10 * tr + m11 * tg + m12 * tb;
    let ob = m20 * tr + m21 * tg + m22 * tb;
    if (sat !== 1) {
      const l = lr * or + lg * og + lb * ob;
      or = l + (or - l) * sat;
      og = l + (og - l) * sat;
      ob = l + (ob - l) * sat;
    }

    for (let c = 0; c < 3; c += 1) {
      const raw = c === 0 ? or : c === 1 ? og : ob;
      const nits = Math.min(scenePeak, raw > 0 ? raw * reference : 0);
      const t = nits * scale;
      const lo = Math.min(ROLL_BINS - 2, Math.max(0, Math.floor(t)));
      const rolled = table[lo]! + (table[lo + 1]! - table[lo]!) * (t - lo);
      out[i + c] = Math.round(Math.min(1, rolled / peak) * MAX);
    }
  }
  return { ...image, data };
}

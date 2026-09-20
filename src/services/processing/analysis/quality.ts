// One quality number for every encoder this app writes (§10.1).
//
// A reader picking "how good should this be" should not have to know that libaom counts
// down from 63 and libjpeg counts up from 1, that PQ needs a far tighter quantizer than
// sRGB for the same picture, or that JXL measures a distance instead. So settings and the
// export dialog carry **perceived quality, 0-100, higher is better**, and this is the only
// place it becomes an encoder's own number.
//
// It also collapses the pairs. A rendition carrying an SDR quantizer beside an HDR one is
// what the raw scale forces, the same number buying different pictures; here that
// difference is the mapping's business, so one setting covers both.
//
// **The anchors are matched to the values these settings shipped with, not measured.** Each
// row below is a point the old defaults established - §10.1 matched libvips Q80 to quantizer
// 13 and Q88 to 8 on SSIM, and §10.7 chose 3 and 1 for PQ against banding in a smooth sky -
// and everything between them is interpolated. That is enough to keep every rendition
// byte-identical across the change, and no more than that: the curve *between* anchors is
// asserted rather than measured. Replacing a row with a measured one is the intended edit,
// which is why the table is data and the interpolation knows nothing about it.

/** What a frame is being encoded as, since the same quality is a different number for each. */
export type QualityTarget = 'avif-sdr' | 'avif-hdr' | 'jpeg' | 'jxl';

/**
 * `[perceived quality, the encoder's own parameter]`, ascending by quality.
 *
 * Whether the parameter rises or falls with quality is the encoder's business and not stated
 * anywhere: interpolation between two anchors carries the direction for free.
 */
const ANCHORS: Record<QualityTarget, [number, number][]> = {
  // libaom's quantizer, 0-63, lower is better.
  'avif-sdr': [
    [0, 63],
    [80, 13],
    [88, 8],
    [100, 0],
  ],
  // The same encoder, and deliberately not the same curve. A PQ photograph occupies about
  // half the code range an sRGB one does - p0.1 to p99.9 spans 0.48 of the container against
  // 0.99 - so a quantizer step lands on a signal with half the contrast and does twice the
  // damage for it (§10.7).
  //
  // What sets the top of this curve is banding in a smooth sky, and it is a cliff rather than
  // a slope: measured down a 61MP gradient, a 12-bit encode holds the ramp to q2 and lets go
  // at q3, and by q5 a 10-bit file walks 6 code values where the source has 455. No depth,
  // dither or chroma setting rescues a number chosen above that cliff, so flattening these
  // anchors towards the SDR ones bands every sky in the library.
  'avif-hdr': [
    [0, 40],
    [80, 3],
    [88, 1],
    [100, 0],
  ],
  // libjpeg's quality, 1-100, higher is better. Not the identity: 100 disables quantisation
  // and quadruples the file for no visible gain, and below ~40 libjpeg is already past what
  // the AVIF anchors call 0.
  jpeg: [
    [0, 30],
    [80, 85],
    [88, 92],
    [100, 100],
  ],
  // libjxl's butteraugli distance, 0-15, lower is better and 0 is mathematically lossless.
  jxl: [
    [0, 7],
    [80, 1.5],
    [88, 1],
    [100, 0],
  ],
};

/** The encoder's own number for a perceived quality, rounded where the encoder wants an integer. */
export function encoderQuality(target: QualityTarget, quality: number): number {
  const anchors = ANCHORS[target];
  const wanted = Math.min(Math.max(quality, 0), 100);
  const above = anchors.findIndex(([at]) => at >= wanted);
  if (above <= 0) return round(target, anchors[0]![1]);
  const [lowAt, lowValue] = anchors[above - 1]!;
  const [highAt, highValue] = anchors[above]!;
  const along = (wanted - lowAt) / (highAt - lowAt);
  return round(target, lowValue + along * (highValue - lowValue));
}

// JXL takes a distance and the rest take an integer setting.
function round(target: QualityTarget, value: number): number {
  return target === 'jxl' ? Math.round(value * 100) / 100 : Math.round(value);
}

/**
 * The perceived quality an encoder's own number stands for: [`encoderQuality`] backwards.
 *
 * For reading a value tuned on an encoder's scale back onto this one, which is what the
 * settings migration does. Not exact in both directions - both ends round to an integer, and
 * several quantizers can share a quality - so it is a reading of an old number rather than a
 * round trip to rely on.
 */
export function perceivedQuality(target: QualityTarget, value: number): number {
  const anchors = ANCHORS[target];
  // Each segment is monotonic but the direction is the encoder's, so both orderings appear.
  for (let i = 1; i < anchors.length; i++) {
    const [lowAt, low] = anchors[i - 1]!;
    const [highAt, high] = anchors[i]!;
    const [min, max] = low <= high ? [low, high] : [high, low];
    if (value < min || value > max) continue;
    const along = high === low ? 0 : (value - low) / (high - low);
    return Math.round(lowAt + along * (highAt - lowAt));
  }
  // Off the end of the table, which is where a hand-edited setting lands: whichever
  // extreme it is nearest.
  const [firstAt, first] = anchors[0]!;
  const [lastAt, last] = anchors[anchors.length - 1]!;
  return Math.abs(value - first) <= Math.abs(value - last) ? firstAt : lastAt;
}

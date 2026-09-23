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
// **The AVIF rows are libaom's IQ tune at the bytes its SSIM tune spent at the quantizers
// these settings were set at.** §10.1 matched libvips Q80 to SSIM quantizer 13 and Q88 to 8,
// and §10.7 chose 3 and 1 for PQ against banding in a smooth sky; each row is the IQ quantizer
// spending the same bytes, the median over the six fixtures (`examples/aom_quality.rs`), and
// the pairs at 80 and 88 were looked at side by side and read as the same picture. The middle
// rows hold that match down the range, where the two tunes' curves bend apart. SDR's match
// depends on size - SSIM's 13 is IQ's 17.5 on an 800px grid tile and 19.7 at 3840 - and the
// rows lean to the grid's, the SDR every library builds.
//
// The JPEG and JXL rows are the values those settings shipped with, asserted rather than
// measured. Between rows is interpolated, and replacing a row with a measured one is the
// intended edit, which is why the table is data and the interpolation knows nothing about it.

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
    [37, 49],
    [69, 27],
    [80, 18],
    [88, 11],
    [100, 0],
  ],
  // The same encoder, and deliberately not the same curve. A PQ photograph occupies about
  // half the code range an sRGB one does - p0.1 to p99.9 spans 0.48 of the container against
  // 0.99 - so a quantizer step lands on a signal with half the contrast and does twice the
  // damage for it (§10.7).
  //
  // What sets the top of this curve is banding in a smooth sky, and it is a cliff rather than
  // a slope: measured down a 61MP gradient, a 12-bit encode under SSIM holds the ramp to q2
  // and lets go at q3, and by q5 a 10-bit file walks 6 code values where the source has 455.
  // No depth, dither or chroma setting rescues a number chosen above that cliff, so flattening
  // these anchors towards the SDR ones bands every sky in the library. IQ spends its bytes on
  // flat regions, and at 4 keeps more of a synthetic sky's levels than SSIM does at 3.
  'avif-hdr': [
    [0, 63],
    [43, 35],
    [65, 16],
    [80, 4],
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

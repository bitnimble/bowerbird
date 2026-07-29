// The HDR colour fit and grade against a real RAW and its real embedded JPEG. None of
// this is visible from a synthetic input: the curves come out of the camera's own
// rendering, and the failure modes that mattered were all "the fit ran and the picture
// was wrong" (§10.8).
//
// The fit, the grade and both encoders are in `native/rawshim` now, so these reach them
// through the shim. `fitHdrColour` and `hdrGradedSamples` exist for exactly this: the
// production path keeps every sample on the Rust side, and there is nothing to assert
// about a picture that never comes back.
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fitMatchProfile, type MatchProfile } from '../../src/services/processing/jpeg_match';
import {
  decodeRawImage,
  encodeHdrRendition,
  fitHdrMatch,
  freeHdrMatch,
  freeImage,
  hdrMatchColour,
  type HdrMatchHandle,
  type HdrOptions,
  type ImageHandle,
} from '../../src/services/processing/rawshim_ops';
import { hdrGradedSamples } from '../../src/services/processing/rawshim_pixels';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const QUANTILE = 0.9;
const REFERENCE = 203;
const PEAK = 1000;
const TIMEOUT = 180_000;

function options(overrides: Partial<HdrOptions> = {}): HdrOptions {
  return {
    variant: 'pq',
    medium: 'still',
    outputPath: '/dev/null',
    peakNits: PEAK,
    referenceWhiteNits: REFERENCE,
    whiteQuantile: QUANTILE,
    crf: 40,
    preset: 8,
    maxEdge: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

// The decode and both fits are deterministic and take no account of anything a
// test does with them, so they are shared: refitting per case was most of this
// file's runtime.
let profile: MatchProfile | null;
let linear: ImageHandle;
let matched: HdrMatchHandle | null;

beforeAll(() => {
  profile = fitMatchProfile(FIXTURE);
  linear = decodeRawImage(FIXTURE, 16, 'rec2020-linear', 0);
  matched = fitHdrMatch(linear, FIXTURE, options(), profile);
});

afterAll(() => {
  if (matched != null) freeHdrMatch(matched);
  freeImage(linear);
});

/** The luma quantiles of a graded frame, in nits. */
function quantiles(data: Buffer): (q: number) => number {
  const s = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const luma = new Float64Array(Math.floor(s.length / 3));
  for (let p = 0; p < luma.length; p += 1) {
    const i = p * 3;
    luma[p] = ((0.2627 * s[i]! + 0.678 * s[i + 1]! + 0.0593 * s[i + 2]!) / 65535) * PEAK;
  }
  luma.sort();
  return (q: number) => luma[Math.floor(q * (luma.length - 1))]!;
}

test(
  'the fit reproduces the camera rendering, and reuses the geometry the SDR fit resolved',
  () => {
    expect(profile).not.toBeNull();
    expect(matched).not.toBeNull();
    const colour = hdrMatchColour(matched!);
    // The same bound the SDR path applies to itself. Above it the transform is not
    // worth applying and the caller renders untransformed.
    expect(colour.deltaE).toBeLessThan(6);
    // Not refitted here: geometry is a property of the lens, not of a colour space,
    // and searching it again would be seconds of work for the same answer.
    expect(['camera', 'fitted', 'none']).toContain(profile!.distortionSource);
  },
  TIMEOUT,
);

test(
  'the fitted transform is monotone, so a gradient cannot posterise',
  () => {
    const colour = hdrMatchColour(matched!);
    for (const curve of colour.curves) {
      for (let i = 1; i < curve.length; i += 1) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
    }
  },
  TIMEOUT,
);

// The regression the shipped extrapolation exists for. Before it, red and green left
// the fit domain at slopes differing by more than 2x and the sky drifted magenta; the
// end values are what that divergence shows up in.
test(
  'the three channels leave the fit domain at comparable levels',
  () => {
    const colour = hdrMatchColour(matched!);
    const ends = colour.curves.map((curve: number[]) => curve[curve.length - 1]!);
    const spread = Math.max(...ends) / Math.min(...ends);
    expect(spread).toBeLessThan(1.5);
  },
  TIMEOUT,
);

test(
  'grading with the match keeps diffuse white near the reference',
  () => {
    const graded = hdrGradedSamples(linear, matched, options());
    const at = quantiles(graded.data);

    // The anchor is measured on the brightest component and this is luma, so the
    // quantile lands under the reference rather than on it - but nowhere near the
    // peak, which is what a lost anchor would look like.
    expect(at(QUANTILE)).toBeGreaterThan(REFERENCE * 0.25);
    expect(at(QUANTILE)).toBeLessThan(REFERENCE * 1.5);
    // Nothing may exceed the display peak the file will declare.
    expect(at(1)).toBeLessThanOrEqual(PEAK + 1);
  },
  TIMEOUT,
);

test(
  'the neutral grade is reproducible, and differs from the matched one',
  () => {
    // At a rendition's size, not the frame's: what is being compared is whether two
    // grades agree, which no amount of resolution makes truer.
    const small = options({ maxEdge: 800 });
    const first = hdrGradedSamples(linear, null, small);
    const second = hdrGradedSamples(linear, null, small);
    expect(Buffer.compare(first.data, second.data)).toBe(0);
    // Otherwise the profile is being dropped somewhere between here and the grade,
    // which is the failure this file was written for.
    expect(Buffer.compare(first.data, hdrGradedSamples(linear, matched, small).data)).not.toBe(0);
  },
  TIMEOUT,
);

// Through the encode, not the grade, because that is where the match was being
// dropped: the options used to be built by spread, TypeScript does not excess-check a
// spread, and an undeclared field vanished in silence. Every unit test calling the
// grade directly kept passing while the product path rendered unmatched.
test(
  'the encode carries the match through to the encoded file',
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-match-'));
    try {
      const plainFile = path.join(dir, 'plain.avif');
      const matchedFile = path.join(dir, 'matched.avif');
      encodeHdrRendition(linear, null, options({ outputPath: plainFile, maxEdge: 640 }));
      encodeHdrRendition(linear, matched, options({ outputPath: matchedFile, maxEdge: 640 }));
      // Same encoder, same size, same everything but the transform, so identical bytes
      // mean the transform never reached the encoder.
      expect(Buffer.compare(readFileSync(plainFile), readFileSync(matchedFile))).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  TIMEOUT,
);

// Renditions of one photo must not disagree about how bright it is. The grade runs
// after the fit-to-size rather than before, so without sharing the levels each size
// would measure its own - and averaging pulls a specular peak in, so the numbers would
// drift apart with the scale factor.
test(
  'every size of one photo grades to the same brightness',
  () => {
    const median = (maxEdge: number): number => quantiles(hdrGradedSamples(linear, matched, options({ maxEdge })).data)(0.5);
    const native = median(Number.POSITIVE_INFINITY);
    for (const other of [median(3012), median(753)]) {
      expect(Math.abs(other - native) / native).toBeLessThan(0.05);
    }
  },
  TIMEOUT,
);

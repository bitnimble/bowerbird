// The HDR colour fit and grade against a real RAW and its real embedded JPEG. None of
// this is visible from a synthetic input: the curves come out of the camera's own
// rendering, and the failure modes that mattered were all "the fit ran and the picture
// was wrong" (§10.8).
//
// The fit, the grade and both encoders are in `native/rawshim`, and no sample ever
// comes back: what these assert on is a digest, a quantile or a curve, each computed
// where the pixels are (`rawshim_debug.ts`).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  encodeHdr,
  gradedSummary,
  hdrMatchColour,
  type GradeSpec,
} from '../../src/services/processing/rawshim_debug';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const QUANTILE = 0.9;
const REFERENCE = 203;
const PEAK = 1000;
const TIMEOUT = 180_000;

function grade(overrides: Partial<GradeSpec> = {}): GradeSpec {
  return {
    peakNits: PEAK,
    referenceWhiteNits: REFERENCE,
    whiteQuantile: QUANTILE,
    crf: 40,
    preset: 8,
    stillFullChroma: false,
    maxEdge: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

test(
  'the fit reproduces the camera rendering, and reuses the geometry the SDR fit resolved',
  () => {
    const colour = hdrMatchColour(FIXTURE, grade());
    // The same bound the SDR path applies to itself. Above it the transform is not
    // worth applying and the caller renders untransformed.
    expect(colour.deltaE).toBeLessThan(6);
    // Not refitted here: geometry is a property of the lens, not of a colour space,
    // and searching it again would be seconds of work for the same answer.
    expect(['camera', 'fitted', 'none']).toContain(colour.distortionSource);
  },
  TIMEOUT,
);

test(
  'the fitted transform is monotone, so a gradient cannot posterise',
  () => {
    const colour = hdrMatchColour(FIXTURE, grade());
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
    const colour = hdrMatchColour(FIXTURE, grade());
    const ends = colour.curves.map((curve: number[]) => curve[curve.length - 1]!);
    const spread = Math.max(...ends) / Math.min(...ends);
    expect(spread).toBeLessThan(1.5);
  },
  TIMEOUT,
);

test(
  'grading with the match keeps diffuse white near the reference',
  () => {
    const [atQuantile, atPeak] = gradedSummary(FIXTURE, grade(), {
      withMatch: true,
      quantiles: [QUANTILE, 1],
    }).quantiles;

    // The anchor is measured on the brightest component and this is luma, so the
    // quantile lands under the reference rather than on it - but nowhere near the
    // peak, which is what a lost anchor would look like.
    expect(atQuantile!).toBeGreaterThan(REFERENCE * 0.25);
    expect(atQuantile!).toBeLessThan(REFERENCE * 1.5);
    // Nothing may exceed the display peak the file will declare.
    expect(atPeak!).toBeLessThanOrEqual(PEAK + 1);
  },
  TIMEOUT,
);

test(
  'the neutral grade is reproducible, and differs from the matched one',
  () => {
    // At a rendition's size, not the frame's: what is being compared is whether two
    // grades agree, which no amount of resolution makes truer.
    const small = grade({ maxEdge: 800 });
    // A digest, which is what "the same samples" meant when this compared buffers -
    // and says it over the whole frame rather than up to the first difference.
    const first = gradedSummary(FIXTURE, small).sha256;
    expect(gradedSummary(FIXTURE, small).sha256).toBe(first);
    // Otherwise the profile is being dropped somewhere between here and the grade,
    // which is the failure this file was written for.
    expect(gradedSummary(FIXTURE, small, { withMatch: true }).sha256).not.toBe(first);
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
      encodeHdr(FIXTURE, grade({ outputPath: plainFile, maxEdge: 640 }));
      encodeHdr(FIXTURE, grade({ outputPath: matchedFile, maxEdge: 640 }), { withMatch: true });
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
    const median = (maxEdge: number): number =>
      gradedSummary(FIXTURE, grade({ maxEdge }), { withMatch: true, quantiles: [0.5] }).quantiles[0]!;
    const native = median(Number.POSITIVE_INFINITY);
    for (const other of [median(3012), median(753)]) {
      expect(Math.abs(other - native) / native).toBeLessThan(0.05);
    }
  },
  TIMEOUT,
);

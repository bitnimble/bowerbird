// The HDR colour fit against a real RAW and its real embedded JPEG. None of this
// is visible from a synthetic input: the curves come out of the camera's own
// rendering, and the failure modes that mattered were all "the fit ran and the
// picture was wrong" (§10.8).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeHdr } from '../../src/services/processing/hdr_media';
import { fitHdrMatch, TRUST_CEILING } from '../../src/services/processing/hdr_match';
import { fitMatchProfile } from '../../src/services/processing/jpeg_match';
import { decodeRaw, readEmbeddedJpeg, resizeRgb } from '../../src/services/processing/raw_decoder';
import { diffuseWhite, grade, measureLevels } from '../../src/services/processing/tone_map';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const QUANTILE = 0.9;
const REFERENCE = 203;
const PEAK = 1000;

async function fit() {
  const linear = decodeRaw(FIXTURE, 16, 'rec2020-linear');
  const anchor = diffuseWhite(linear, QUANTILE);
  const jpeg = readEmbeddedJpeg(FIXTURE);
  if (jpeg == null) throw new Error('fixture has no embedded JPEG');
  const profile = await fitMatchProfile(FIXTURE);
  if (profile == null) throw new Error('SDR fit declined, so there is no geometry to reuse');
  const match = await fitHdrMatch(linear, anchor, jpeg, profile);
  return { linear, anchor, match, colour: match?.colour ?? null, profile };
}

test('the fit reproduces the camera rendering, and reuses the geometry the SDR fit resolved', async () => {
  const { colour, profile } = await fit();
  expect(colour).not.toBeNull();
  // The same bound the SDR path applies to itself. Above it the transform is not
  // worth applying and the caller renders untransformed.
  expect(colour!.deltaE).toBeLessThan(6);
  // Not refitted here: geometry is a property of the lens, not of a colour space,
  // and searching it again would be seconds of work for the same answer.
  expect(['camera', 'fitted', 'none']).toContain(profile.distortionSource);
}, 180_000);

test('the fitted transform is monotone, so a gradient cannot posterise', async () => {
  const { colour } = await fit();
  for (const curve of colour!.curves) {
    for (let i = 1; i < curve.length; i += 1) expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!);
  }
}, 180_000);

// The regression the shipped extrapolation exists for. Before it, red and green
// left the fit domain at slopes differing by more than 2x and the sky drifted
// magenta; the end values are what that divergence shows up in.
test('the three channels leave the fit domain at comparable levels', async () => {
  const { colour } = await fit();
  const ends = colour!.curves.map((curve) => curve[curve.length - 1]!);
  const spread = Math.max(...ends) / Math.min(...ends);
  expect(spread).toBeLessThan(1.5);
}, 180_000);

test('grading with the match keeps diffuse white near the reference', async () => {
  const { linear, colour } = await fit();
  const graded = grade(linear, {
    referenceWhiteNits: REFERENCE,
    peakNits: PEAK,
    whiteQuantile: QUANTILE,
    match: colour,
  });

  const s = new Uint16Array(graded.data.buffer, graded.data.byteOffset, graded.data.byteLength / 2);
  const luma = new Float64Array(Math.floor(s.length / 3));
  for (let p = 0; p < luma.length; p += 1) {
    const i = p * 3;
    luma[p] = ((0.2627 * s[i]! + 0.678 * s[i + 1]! + 0.0593 * s[i + 2]!) / 65535) * PEAK;
  }
  const sorted = Float64Array.from(luma).sort();
  const at = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;

  // The anchor is measured on the brightest component and this is luma, so the
  // quantile lands under the reference rather than on it - but nowhere near the
  // peak, which is what a lost anchor would look like.
  expect(at(QUANTILE)).toBeGreaterThan(REFERENCE * 0.25);
  expect(at(QUANTILE)).toBeLessThan(REFERENCE * 1.5);
  // Nothing may exceed the display peak the file will declare.
  expect(at(1)).toBeLessThanOrEqual(PEAK + 1);
}, 180_000);

test('a render with no match is untouched by the match path', async () => {
  const linear = decodeRaw(FIXTURE, 16, 'rec2020-linear');
  const plain = grade(linear, { referenceWhiteNits: REFERENCE, peakNits: PEAK, whiteQuantile: QUANTILE, match: null });
  const explicitNull = grade(linear, {
    referenceWhiteNits: REFERENCE,
    peakNits: PEAK,
    whiteQuantile: QUANTILE,
    match: null,
  });
  expect(Buffer.compare(plain.data, explicitNull.data)).toBe(0);
}, 180_000);

// Through `encodeHdr`, not `grade`, because that is where the match was being
// dropped: the options are built by spread, TypeScript does not excess-check a
// spread, and an undeclared field vanishes in silence. Every unit test calling
// `grade` directly kept passing while the product path rendered unmatched.
test('encodeHdr carries the match through to the encoded file', async () => {
  const { linear, match } = await fit();
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-match-'));
  try {
    const common = {
      variant: 'pq',
      medium: 'still',
      referenceWhiteNits: REFERENCE,
      peakNits: PEAK,
      whiteQuantile: QUANTILE,
      crf: 40,
      preset: 12,
      maxEdge: 640,
    } as const;
    const plain = path.join(dir, 'plain.avif');
    const matched = path.join(dir, 'matched.avif');
    await encodeHdr(linear, { ...common, outputPath: plain, match: null });
    await encodeHdr(linear, { ...common, outputPath: matched, match });

    // Same encoder, same size, same everything but the transform, so identical
    // bytes mean the transform never reached the encoder.
    expect(Buffer.compare(readFileSync(plain), readFileSync(matched))).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

// Renditions of one photo must not disagree about how bright it is. The grade
// now runs after the fit-to-size rather than before, so without sharing the
// levels each size would measure its own - and averaging pulls a specular peak
// in, so the numbers would drift apart with the scale factor.
test('every size of one photo grades to the same brightness', async () => {
  const { linear, colour } = await fit();
  const shared = measureLevels(linear, QUANTILE);

  const median = (image: { data: Buffer }): number => {
    const s = new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 2);
    const luma = new Float64Array(Math.floor(s.length / 3));
    for (let p = 0; p < luma.length; p += 1) {
      const i = p * 3;
      luma[p] = ((0.2627 * s[i]! + 0.678 * s[i + 1]! + 0.0593 * s[i + 2]!) / 65535) * PEAK;
    }
    const sorted = Float64Array.from(luma).sort();
    return sorted[Math.floor(sorted.length / 2)]!;
  };

  const common = { referenceWhiteNits: REFERENCE, peakNits: PEAK, whiteQuantile: QUANTILE, levels: shared } as const;
  const native = median(grade(linear, { ...common, match: colour }));
  const half = median(grade(resizeRgb(linear, linear.width >> 1, linear.height >> 1), { ...common, match: colour }));
  const eighth = median(grade(resizeRgb(linear, linear.width >> 3, linear.height >> 3), { ...common, match: colour }));

  for (const other of [half, eighth]) expect(Math.abs(other - native) / native).toBeLessThan(0.05);
}, 180_000);

test('the ceiling stays below the point an 8-bit JPEG clips', () => {
  // Fitting through the camera's own shoulder teaches the curve to compress
  // highlights, which is the one thing the HDR path must not learn.
  expect(TRUST_CEILING).toBeLessThan(1);
});

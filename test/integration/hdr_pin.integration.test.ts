// Pins the HDR encode's two outputs before it moves into Rust: the argv handed to
// ffmpeg and avifenc, and the graded 16-bit samples piped to them.
//
// A port of this subsystem cannot be verified by "the tests still pass". The argv
// carries colour signalling whose loss is invisible until a browser refuses to
// treat a file as HDR, and the grade has failure modes that look like ordinary
// pictures - DESIGN §10.7.1 records a magenta sky at deltaA* +5.2 from per-channel
// extrapolation, and a matrix that oversaturated by 9.3% before it was weighted.
// Neither would fail an assertion about shape. So the current behaviour is recorded
// byte for byte first, and the port is held to it.
//
// The expected files are generated from this same code path, so they are a
// regression net rather than an independent oracle: they say "nothing changed",
// not "this is correct". Correctness is what the other HDR tests and a real HDR
// display are for. Regenerate deliberately, never to make a red test green:
//   BOWERBIRD_UPDATE_PINS=1 bun test test/integration/hdr_pin.integration.test.ts
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyHdrGeometry, fitHdrMatch } from '../../src/services/processing/hdr_match';
import {
  avifencArgs,
  ffmpegArgs,
  targetSize,
  HDR_MEDIA,
  HDR_VARIANTS,
  type HdrEncodeOptions,
} from '../../src/services/processing/hdr_media';
import { fitMatchProfile } from '../../src/services/processing/jpeg_match';
import { decodeRaw, resizeRgb } from '../../src/services/processing/raw_decoder';
import { diffuseWhite, grade, measureLevels } from '../../src/services/processing/tone_map';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const ARGV_PIN = `${import.meta.dir}/../fixtures/hdr_argv.pin.txt`;
const GRADE_PIN = `${import.meta.dir}/../fixtures/hdr_grade.pin.txt`;
// An env var, not a flag: `bun test` does not forward unknown flags to process.argv.
const UPDATE = process.env.BOWERBIRD_UPDATE_PINS === '1';
const TIMEOUT = 300_000;

// Unit separator, so a row survives arguments that contain spaces.
const SEP = ' \x1f ';

function check(path: string, actual: string): void {
  if (UPDATE) {
    writeFileSync(path, actual);
    return;
  }
  const expected = readFileSync(path, 'utf8');
  // Compared line by line: a diff of two 192-line blobs names nothing useful.
  const want = expected.trimEnd().split('\n');
  const got = actual.trimEnd().split('\n');
  for (let i = 0; i < Math.max(want.length, got.length); i += 1) {
    expect(got[i], `row ${i + 1} of ${path}`).toBe(want[i]);
  }
}

const SIZES = [
  { width: 4024, height: 6024 }, // 24MP portrait
  { width: 9504, height: 6336 }, // 61MP landscape
  { width: 6336, height: 9504 }, // 61MP portrait: the one that meets SVT's height ceiling
  { width: 800, height: 533 }, // already inside any edge
];
const EDGES = [3840, 800, Number.POSITIVE_INFINITY];

test('every argv the encoder builds, across the variant and medium matrix', () => {
  const rows: string[] = [];
  for (const variant of HDR_VARIANTS) {
    for (const medium of HDR_MEDIA) {
      for (const size of SIZES) {
        for (const maxEdge of EDGES) {
          const options: HdrEncodeOptions = {
            variant,
            medium,
            outputPath: '/out/rendition' + (medium === 'video' ? '.mp4' : '.avif'),
            peakNits: 1000,
            referenceWhiteNits: 203,
            whiteQuantile: 0.9,
            match: null,
            crf: 8,
            preset: 8,
            maxEdge,
          };
          const key = `${variant}|${medium}|${size.width}x${size.height}|edge=${maxEdge}`;
          const fit = targetSize(size, options);
          rows.push(`${key}\tsize\t${fit.width}x${fit.height}`);
          rows.push(`${key}\tffmpeg\t${ffmpegArgs(size, options).join(SEP)}`);
          if (medium !== 'video') {
            rows.push(`${key}\tavifenc\t${avifencArgs(options, '/out/rendition.avif.y4m').join(SEP)}`);
          }
        }
      }
    }
  }
  check(ARGV_PIN, `${rows.join('\n')}\n`);
});

test(
  'the graded samples: neutral and matched, with and without the roll-off',
  async () => {
    const rows: string[] = [];

    // peakNits is a case dimension, not a constant, because the roll-off is
    // conditional: eetf returns early when the frame already fits the display, so
    // at 1000 nits this fixture never reaches the BT.2390 knee at all. A pin
    // without a low-peak case would have covered none of that curve - which is
    // where the subtlest arithmetic in the grade lives - and was silently passing
    // a deliberate perturbation of it. 203 is also what the SDR reference uses.
    for (const [label, withMatch, maxEdge, peakNits] of [
      ['neutral-3840', false, 3840, 1000],
      ['matched-3840', true, 3840, 1000],
      ['matched-800', true, 800, 1000],
      ['neutral-rolloff', false, 800, 203],
      ['matched-rolloff', true, 800, 203],
    ] as const) {
      const linear = decodeRaw(FIXTURE, 16, 'rec2020-linear');
      const size = targetSize(linear, { medium: 'still', maxEdge });

      let match = null;
      if (withMatch) {
        const profile = fitMatchProfile(FIXTURE);
        expect(profile, 'the SDR fit supplies the geometry this reuses').not.toBeNull();
        match = await fitHdrMatch(linear, diffuseWhite(linear, 0.9), FIXTURE, profile!);
        expect(match, 'the HDR colour fit').not.toBeNull();
      }

      const fittedImage = resizeRgb(linear, size.width, size.height);
      const shaped = match == null ? fittedImage : applyHdrGeometry(fittedImage, match);
      const graded = grade(shaped, {
        referenceWhiteNits: 203,
        whiteQuantile: 0.9,
        levels: measureLevels(linear, 0.9),
        match: match?.colour ?? null,
        peakNits,
      });

      const samples = new Uint16Array(graded.data.buffer, graded.data.byteOffset, graded.data.byteLength / 2);
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(graded.data);

      // Per channel, because a shift in one is what a wrong matrix row looks like
      // and a whole-frame mean would hide it.
      const stats = [0, 1, 2].map((c) => {
        let min = 65535;
        let max = 0;
        let sum = 0;
        let n = 0;
        for (let i = c; i < samples.length; i += 3) {
          const v = samples[i]!;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          n += 1;
        }
        return `${min}/${max}/${(sum / n).toFixed(2)}`;
      });

      rows.push(`${label}\tsize\t${graded.width}x${graded.height}`);
      rows.push(`${label}\tsha256\t${hasher.digest('hex')}`);
      rows.push(`${label}\tstats\t${stats.join(' ')}`);
      // A prime stride, so it walks all three channels and cannot land on a
      // repeating pattern.
      const picked: number[] = [];
      for (let i = 0; i < samples.length; i += 9973) picked.push(samples[i]!);
      rows.push(`${label}\tsamples\t${picked.join(',')}`);
    }

    check(GRADE_PIN, `${rows.join('\n')}\n`);
  },
  TIMEOUT,
);

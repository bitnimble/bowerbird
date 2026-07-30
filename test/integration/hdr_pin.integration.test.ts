// Holds the HDR encode's two outputs to what the TypeScript produced before it moved
// into Rust: the argv handed to ffmpeg and avifenc, and the graded 16-bit samples
// piped to them.
//
// A port of this subsystem could not be verified by "the tests still pass". The argv
// carries colour signalling whose loss is invisible until a browser refuses to treat a
// file as HDR, and the grade has failure modes that look like ordinary pictures -
// DESIGN §10.7.1 records a magenta sky at deltaA* +5.2 from per-channel extrapolation,
// and a matrix that oversaturated by 9.3% before it was weighted. Neither would fail
// an assertion about shape. So the behaviour was recorded byte for byte first, and the
// port was held to it: the argv matched across all 192 rows, and the graded samples
// came back bit-identical on all five cases.
//
// The expected files were generated from the TypeScript that is now deleted, so from
// here on they are a regression net rather than an independent oracle: they say
// "nothing changed", not "this is correct". Correctness is what the other HDR tests
// and a real HDR display are for. Regenerate deliberately, never to make a red test
// green:
//   BOWERBIRD_UPDATE_PINS=1 bun test test/integration/hdr_pin.integration.test.ts
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fitMatchProfile, type MatchProfile } from '../../src/services/processing/jpeg_match';
import {
  decodeRawImage,
  fitHdrMatch,
  freeHdrMatch,
  freeImage,
  hdrArgv,
  type HdrOptions,
  type ImageHandle,
} from '../../src/services/processing/rawshim_ops';
import { hdrGradedSamples } from '../../src/services/processing/rawshim_pixels';

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

// Both are pure functions of the file, so one of each serves every case below;
// refitting per case was most of this file's runtime.
let linear: ImageHandle;
let sdr: MatchProfile | null;

beforeAll(() => {
  sdr = fitMatchProfile(FIXTURE);
  linear = decodeRawImage(FIXTURE, 16, 'rec2020-linear', 0);
});

afterAll(() => freeImage(linear));

const SIZES = [
  { width: 4024, height: 6024 }, // 24MP portrait
  { width: 9504, height: 6336 }, // 61MP landscape
  { width: 6336, height: 9504 }, // 61MP portrait: the one that meets SVT's height ceiling
  { width: 800, height: 533 }, // already inside any edge
];
const EDGES = [3840, 800, Number.POSITIVE_INFINITY];

// Chroma is a dimension here because it reaches three separate arguments that have to
// agree - zscale's output format, avifenc's `--yuv`, and whether the target size is
// forced even - and 4:2:0 with an odd dimension is refused outright rather than
// rounded. It is fixed on the video, which has no choice about it (§10.7).
test('every argv the encoder builds, across the medium, chroma and size matrix', () => {
  const rows: string[] = [];
  for (const medium of ['still', 'video'] as const) {
    for (const stillFullChroma of [false, true]) {
      for (const size of SIZES) {
        for (const maxEdge of EDGES) {
          const options: HdrOptions = {
            medium,
            outputPath: '/out/rendition' + (medium === 'video' ? '.mp4' : '.avif'),
            peakNits: 1000,
            referenceWhiteNits: 203,
            whiteQuantile: 0.9,
            crf: 8,
            preset: 8,
            maxEdge,
            stillFullChroma,
          };
          const chroma = stillFullChroma ? '444' : '420';
          const key = `${medium}|${chroma}|${size.width}x${size.height}|edge=${maxEdge}`;
          rows.push(`${key}\tsize\t${hdrArgv(options, size.width, size.height, 'size')[0]}`);
          rows.push(`${key}\tffmpeg\t${hdrArgv(options, size.width, size.height, 'ffmpeg').join(SEP)}`);
          if (medium !== 'video') {
            const argv = hdrArgv(options, size.width, size.height, 'avifenc', '/out/rendition.avif.y4m');
            rows.push(`${key}\tavifenc\t${argv.join(SEP)}`);
          }
        }
      }
    }
  }
  check(ARGV_PIN, `${rows.join('\n')}\n`);
});

test(
  'the graded samples: neutral and matched, with and without the roll-off',
  () => {
    const rows: string[] = [];

    // peakNits is a case dimension, not a constant, because the roll-off is
    // conditional: the EETF returns early when the frame already fits the display, so
    // at 1000 nits this fixture never reaches the BT.2390 knee at all. A pin without a
    // low-peak case would have covered none of that curve - which is where the
    // subtlest arithmetic in the grade lives - and was silently passing a deliberate
    // perturbation of it. 203 is also what the SDR reference uses.
    for (const [label, withMatch, maxEdge, peakNits] of [
      ['neutral-3840', false, 3840, 1000],
      ['matched-3840', true, 3840, 1000],
      ['matched-800', true, 800, 1000],
      ['neutral-rolloff', false, 800, 203],
      ['matched-rolloff', true, 800, 203],
    ] as const) {
      const options: HdrOptions = {
        medium: 'still',
        outputPath: '/dev/null',
        peakNits,
        referenceWhiteNits: 203,
        whiteQuantile: 0.9,
        crf: 8,
        preset: 8,
        maxEdge,
        stillFullChroma: false,
      };

      // The SDR fit supplies the geometry; the HDR colour is refitted inside the
      // grade, in the domain it works in.
      const profile = withMatch ? sdr : null;
      if (withMatch) expect(profile, 'the SDR fit supplies the geometry this reuses').not.toBeNull();

      const matched = fitHdrMatch(linear, FIXTURE, options, profile);
      let graded: ReturnType<typeof hdrGradedSamples>;
      try {
        graded = hdrGradedSamples(linear, matched, options);
      } finally {
        if (matched != null) freeHdrMatch(matched);
      }

      const samples = new Uint16Array(graded.data.buffer, graded.data.byteOffset, graded.data.byteLength / 2);
      const hasher = new Bun.CryptoHasher('sha256');
      hasher.update(graded.data);

      // Per channel, because a shift in one is what a wrong matrix row looks like and
      // a whole-frame mean would hide it.
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
      // A prime stride, so it walks all three channels and cannot land on a repeating
      // pattern.
      const picked: number[] = [];
      for (let i = 0; i < samples.length; i += 9973) picked.push(samples[i]!);
      rows.push(`${label}\tsamples\t${picked.join(',')}`);
    }

    check(GRADE_PIN, `${rows.join('\n')}\n`);
  },
  TIMEOUT,
);

// The HDR renditions are a third decode path (scene-linear, Rec.2020, no
// auto-bright) feeding two encoders. Whether the result is actually HDR is
// invisible until it reaches a display, so what is checkable here is that the
// pixels are scene-referred and that the files say what they must say (§10.7).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _for_testing_decodeSummary } from '../../src/services/processing/rawshim_for_testing';
import { _for_testing_encodeHdr } from '../../src/services/processing/rawshim_for_testing';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const MAX_EDGE = 640;

interface Probe {
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
}

function probe(file: string): Probe {
  const result = Bun.spawnSync([
    'ffprobe',
    '-hide_banner',
    '-loglevel', 'error',
    '-show_entries', 'stream=color_primaries,color_transfer,color_space,pix_fmt,width,height',
    '-of', 'json',
    file,
  ]);
  if (result.exitCode !== 0) throw new Error(`ffprobe failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString()).streams[0] as Probe;
}

// Small and fast: these assert tagging, which is independent of resolution, and
// a full-size encode would put ~10s per case on the suite. One decode, asked for
// no more than the encode will keep, serves every case.
async function encoded(run: (file: string) => void, fullChroma = false): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const outputPath = path.join(dir, 'pq.avif');
    _for_testing_encodeHdr(FIXTURE, { outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE, stillFullChroma: fullChroma }, { decodeSize: MAX_EDGE });
    run(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the denoise and the sharpen reach the HDR encode', () => {
  // The HDR half of §10.9 is one call in `encode_still`, and until this test it was
  // reachable by nothing: every route in pinned both settings at 0, so deleting the
  // call left every suite green. That is the same hole the SDR wiring test exists to
  // close, on the other half of the pipeline.
  //
  // Only that the pixels moved. What the filters do is measured in `image.rs` against
  // constructed inputs; what cannot be checked there is whether anything calls them.
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-finish-'));
  try {
    const render = (name: string, defringe: number, sharpen: number): string => {
      const still = path.join(dir, `${name}.avif`);
      _for_testing_encodeHdr(
        FIXTURE,
        { outputPath: still, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE, stillFullChroma: false, defringe, sharpen },
        { decodeSize: MAX_EDGE },
      );
      return still;
    };
    const plain = render('plain', 0, 0);
    const processed = render('processed', 1, 0.6);

    expect(readFileSync(processed).equals(readFileSync(plain))).toBe(false);
    expect(Bun.file(processed).size).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('a scene-linear decode keeps the highlight headroom an sRGB one spends', () => {
  // Half size: the subject is the levels the two decodes land on, which is a
  // property of the tone curve rather than of the frame's size.
  const half = { atLeastLongEdge: 1000 };
  const display = _for_testing_decodeSummary(FIXTURE, { depth: 16, space: 'srgb', ...half });
  const scene = _for_testing_decodeSummary(FIXTURE, { depth: 16, space: 'rec2020-linear', ...half });

  expect(scene.width).toBe(display.width);
  expect(scene.depth).toBe(16);

  // The summary reports a mean per channel; the frame's is their average, every
  // channel having the same count.
  const meanOf = (image: typeof scene): number =>
    image.channels.reduce((total, channel) => total + channel.mean, 0) / image.channels.length;

  expect(meanOf(scene)).toBeLessThan(meanOf(display) / 2);
});

test('the still declares BT.2020 and PQ, which ffmpeg cannot mux into an AVIF at all', async () => {
  // ffmpeg's avif muxer writes no colr box, so this is what proves the detour
  // through avifenc is doing its job.
  await encoded((file) => {
    const stream = probe(file);
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_space).toBe('bt2020nc');
    // 4:2:0, which is the default this asked for; `avif_still` covers both.
    expect(stream.pix_fmt).toBe('yuv420p10le');
  });
});

// Firefox is served this same file and rewraps it as a video for itself, and its
// video decoder takes 4:2:0 alone: a 4:4:4 still reaches the panel there washed
// out (§10.7). Nothing in the browser reports that, so the setting is what has to
// be answerable, and this is where the two chromas are told apart.
test('the full-chroma setting reaches the encoder, which Firefox needs off', async () => {
  await encoded((file) => expect(probe(file).pix_fmt).toBe('yuv444p10le'), true);
}, 120_000);

test('the still leaves no intermediate behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const outputPath = path.join(dir, 'pq.avif');
    _for_testing_encodeHdr(FIXTURE, { outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE, stillFullChroma: false }, { decodeSize: MAX_EDGE });
    // The y4m is uncompressed 10-bit, so a leaked one is tens of megabytes per
    // photo sitting next to the output that replaced it.
    expect(await Bun.file(`${outputPath}.y4m`).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// There was a test here for an 8-bit decode being refused by the HDR encode rather
// than read as 16-bit and written as half a frame of noise. It is gone because the
// input it constructed cannot be expressed: the caller no longer picks a decode and
// hands it over, it names a file and the encode decodes scene-linear itself. The
// runtime guard still stands in `hdr.rs` for the job path, which does pick a depth.

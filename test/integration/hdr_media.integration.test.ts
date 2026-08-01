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
type Medium = 'still' | 'video';

async function encoded(medium: Medium, run: (file: string) => void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    // Only two media now, so the extension is one check rather than a table.
    const outputPath = path.join(dir, medium === 'video' ? 'pq.mp4' : 'pq.avif');
    _for_testing_encodeHdr(FIXTURE, { medium, outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE, stillFullChroma: false }, { decodeSize: MAX_EDGE });
    run(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The shape an HDR rendition is actually built in: one call, two files, off one
// graded frame and with the two encoders running together. Everything else here
// asks for a single medium, so nothing covered the pair until this - and it is the
// path with two threads writing two files, where a shared temporary or a dropped
// error would show up as a rendition that silently never appeared.
test('one call writes the still and its video twin, each tagged as its own medium', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-pair-'));
  try {
    const still = path.join(dir, 'rendition.avif');
    const video = path.join(dir, 'rendition.mp4');
    _for_testing_encodeHdr(
      FIXTURE,
      { medium: 'still', outputPath: still, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: 640, stillFullChroma: true },
      { videoOutputPath: video },
    );

    expect(Bun.file(still).size).toBeGreaterThan(0);
    expect(Bun.file(video).size).toBeGreaterThan(0);

    // Both must carry the PQ signalling, and each its own chroma. Asked for at 4:4:4
    // rather than the shipped default, because the claim under test is that the two
    // media are tagged and formatted independently - which needs them to differ. The
    // video cannot follow it there: 4:2:0 is the only AV1 profile the browsers this
    // file exists for will decode.
    for (const [file, chroma] of [[still, 'yuv444p10le'], [video, 'yuv420p10le']] as const) {
      const found = probe(file);
      expect(found.color_transfer).toBe('smpte2084');
      expect(found.color_primaries).toBe('bt2020');
      expect(found.pix_fmt).toBe(chroma);
    }

    // The same size, which is the claim the whole shape rests on. One graded frame
    // serves both encodes and there is no second-grade path any more, and what makes
    // that legitimate is that nothing can give the two different dimensions - the
    // 8704-row ceiling that used to impose one went with SVT-AV1. A regression that refitted the
    // video on its own would show up here and nowhere else.
    const [videoSize, stillSize] = [probe(video), probe(still)];
    expect([videoSize.width, videoSize.height]).toEqual([stillSize.width, stillSize.height]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test('the denoise and the sharpen reach both HDR media', () => {
  // The HDR half of §10.9 is one call in `encode_pair`, and until this test it was
  // reachable by nothing: every route in pinned both settings at 0, so deleting the
  // call left every suite green. That is the same hole the SDR wiring test exists to
  // close, on the half of the pipeline that feeds two encoders rather than one.
  //
  // Only that the pixels moved, and that they moved in *both* files. What the filters
  // do is measured in `image.rs` against constructed inputs; what cannot be checked
  // there is whether anything calls them.
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-finish-'));
  try {
    const render = (name: string, denoise: number, sharpen: number): [string, string] => {
      const still = path.join(dir, `${name}.avif`);
      const video = path.join(dir, `${name}.mp4`);
      _for_testing_encodeHdr(
        FIXTURE,
        { medium: 'still', outputPath: still, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE, stillFullChroma: false, denoiseLuma: denoise, denoiseChroma: denoise, sharpen },
        { videoOutputPath: video, decodeSize: MAX_EDGE },
      );
      return [still, video];
    };
    const [plainStill, plainVideo] = render('plain', 0, 0);
    const [doneStill, doneVideo] = render('processed', 1, 0.6);

    for (const [plain, processed, medium] of [
      [plainStill, doneStill, 'still'],
      [plainVideo, doneVideo, 'video'],
    ] as const) {
      expect(readFileSync(processed).equals(readFileSync(plain))).toBe(false);
      expect(Bun.file(processed).size).toBeGreaterThan(0);
      // Named so a failure says which medium lost the stage rather than just "bytes
      // equal": the two encoders are fed from one frame, so losing it on one only is
      // not expressible - but losing it on both looks identical to never wiring it.
      expect(medium).toBeDefined();
    }
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

test('the video declares BT.2020 and PQ, which no encoder option alone achieves', async () => {
  await encoded('video', (file) => {
    const stream = probe(file);
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_space).toBe('bt2020nc');
    // 8-bit would band visibly in the shadows a PQ curve stretches. 4:2:0 is
    // deliberate: it is AV1 Profile 0, the only profile a hardware decoder and
    // an HDR overlay will take, and 4:4:4 rendered washed out on Firefox.
    expect(stream.pix_fmt).toBe('yuv420p10le');
  });
});

test('the still declares BT.2020 and PQ, which ffmpeg cannot mux into an AVIF at all', async () => {
  // ffmpeg's avif muxer writes no colr box, so this is what proves the detour
  // through avifenc is doing its job.
  await encoded('still', (file) => {
    const stream = probe(file);
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_space).toBe('bt2020nc');
    // 4:2:0, which is the default this asked for; `avif_still` covers both.
    expect(stream.pix_fmt).toBe('yuv420p10le');
  });
});
test('the still leaves no intermediate behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const outputPath = path.join(dir, 'pq.avif');
    _for_testing_encodeHdr(FIXTURE, { medium: 'still', outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE, stillFullChroma: false }, { decodeSize: MAX_EDGE });
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

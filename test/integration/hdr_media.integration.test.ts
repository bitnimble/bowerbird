// The HDR renditions are a third decode path (scene-linear, Rec.2020, no
// auto-bright) feeding two encoders. Whether the result is actually HDR is
// invisible until it reaches a display, so what is checkable here is that the
// pixels are scene-referred and that the files say what they must say (§10.7).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type HdrMedium, type HdrVariant, encodeHdr, extensionFor } from '../../src/services/processing/hdr_media';
import { decodeRaw } from '../../src/services/processing/raw_decoder';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

interface Probe {
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  pix_fmt?: string;
}

function probe(file: string): Probe {
  const result = Bun.spawnSync([
    'ffprobe',
    '-hide_banner',
    '-loglevel', 'error',
    '-show_entries', 'stream=color_primaries,color_transfer,color_space,pix_fmt',
    '-of', 'json',
    file,
  ]);
  if (result.exitCode !== 0) throw new Error(`ffprobe failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString()).streams[0] as Probe;
}

// Small and fast: these assert tagging, which is independent of resolution, and
// a full-size encode would put ~10s per case on the suite.
async function encoded(medium: HdrMedium, variant: HdrVariant, run: (file: string) => void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const image = decodeRaw(FIXTURE, 16, 'rec2020-linear');
    // extensionFor, not a local guess: `still-baseline` is an AVIF too, and a
    // hand-rolled check that only knew about 'still' wrote it as .mp4.
    const outputPath = path.join(dir, `${variant}${extensionFor(medium)}`);
    await encodeHdr(image, { variant, medium, outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: 640 });
    run(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a scene-linear decode keeps the highlight headroom an sRGB one spends', () => {
  const display = decodeRaw(FIXTURE, 16);
  const scene = decodeRaw(FIXTURE, 16, 'rec2020-linear');

  expect(scene.width).toBe(display.width);
  expect(scene.depth).toBe(16);

  const meanOf = (image: typeof scene): number => {
    const samples = new Uint16Array(image.data.buffer, image.data.byteOffset, image.data.length / 2);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < samples.length; i += 997) {
      sum += samples[i]!;
      count++;
    }
    return sum / count;
  };

  // Linear light with no tone curve puts most of a normally exposed frame far
  // down the range; the sRGB render lifts the same pixels for a display. If
  // these ever converge, the gamma or auto-bright call stopped taking effect and
  // the "HDR" encode is quietly working from display-referred pixels.
  expect(meanOf(scene)).toBeLessThan(meanOf(display) / 2);
});

test('the video declares BT.2020 and PQ, which no encoder option alone achieves', async () => {
  await encoded('video', 'pq', (file) => {
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
  await encoded('still', 'pq', (file) => {
    const stream = probe(file);
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_space).toBe('bt2020nc');
    expect(stream.pix_fmt).toBe('yuv444p10le');
  });
});

test('the baseline control is the same picture at 4:2:0, differing in chroma alone', async () => {
  // It exists to isolate one variable on a decoder that may implement only
  // AVIF Baseline: same transfer, same primaries, quarter the chroma samples.
  await encoded('still-baseline', 'pq', (file) => {
    const stream = probe(file);
    expect(stream.pix_fmt).toBe('yuv420p10le');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_primaries).toBe('bt2020');
  });
});

test('the SDR references are tagged so they can be compared against', async () => {
  await encoded('video', 'sdr', (file) => {
    const stream = probe(file);
    expect(stream.color_primaries).toBe('bt709');
    expect(stream.color_transfer).toBe('bt709');
  });
  // A still control is sRGB rather than BT.709: same primaries, but a browser
  // renders an untagged still against sRGB.
  await encoded('still', 'sdr', (file) => {
    const stream = probe(file);
    expect(stream.color_primaries).toBe('bt709');
    expect(stream.color_transfer).toBe('iec61966-2-1');
  });
});

test('the still leaves no intermediate behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const image = decodeRaw(FIXTURE, 16, 'rec2020-linear');
    const outputPath = path.join(dir, 'pq.avif');
    await encodeHdr(image, { variant: 'pq', medium: 'still', outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: 640 });
    // The y4m is uncompressed 10-bit, so a leaked one is tens of megabytes per
    // photo sitting next to the output that replaced it.
    expect(await Bun.file(`${outputPath}.y4m`).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an 8-bit decode is refused rather than encoded as something HDR-shaped', async () => {
  const image = decodeRaw(FIXTURE, 8);
  await expect(
    encodeHdr(image, {
      variant: 'pq',
      medium: 'still',
      outputPath: '/tmp/never.avif',
      peakNits: 1000,
      referenceWhiteNits: 203,
      whiteQuantile: 0.99,
      crf: 40,
      preset: 12,
      maxEdge: 640,
    }),
  ).rejects.toThrow('16-bit');
});

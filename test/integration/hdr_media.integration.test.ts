// The HDR renditions are a third decode path (scene-linear, Rec.2020, no
// auto-bright) feeding two encoders. Whether the result is actually HDR is
// invisible until it reaches a display, so what is checkable here is that the
// pixels are scene-referred and that the files say what they must say (§10.7).
//   docker exec bowerbird-dev bun test test/integration
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeRaw } from '../../src/services/processing/rawshim_pixels';
import { decodeRawImage, encodeHdrRendition, freeImage, type ImageHandle } from '../../src/services/processing/rawshim_ops';

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
type Variant = 'pq';

let linear: ImageHandle;
beforeAll(() => {
  linear = decodeRawImage(FIXTURE, 16, 'rec2020-linear', MAX_EDGE);
});
afterAll(() => freeImage(linear));

async function encoded(medium: Medium, variant: Variant, run: (file: string) => void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    // Only two media now, so the extension is one check rather than a table.
    const outputPath = path.join(dir, `${variant}${medium === 'video' ? '.mp4' : '.avif'}`);
    encodeHdrRendition(linear, null, { variant, medium, outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE });
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
    const image = decodeRawImage(FIXTURE, 16, 'rec2020-linear', 0);
    try {
      encodeHdrRendition(
        image,
        null,
        { variant: 'pq', medium: 'still', outputPath: still, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: 640 },
        video,
      );
    } finally {
      freeImage(image);
    }

    expect(Bun.file(still).size).toBeGreaterThan(0);
    expect(Bun.file(video).size).toBeGreaterThan(0);

    // Both must carry the PQ signalling, and each its own chroma: 4:4:4 for the
    // still because it is a photograph, 4:2:0 for the video because that is the
    // only AV1 profile the browsers this file exists for will decode.
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

test('a scene-linear decode keeps the highlight headroom an sRGB one spends', () => {
  // Half size: the subject is the levels the two decodes land on, which is a
  // property of the tone curve rather than of the frame's size.
  const half = { atLeastLongEdge: 1000 };
  const display = decodeRaw(FIXTURE, 16, 'srgb', half);
  const scene = decodeRaw(FIXTURE, 16, 'rec2020-linear', half);

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
test('the still leaves no intermediate behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const outputPath = path.join(dir, 'pq.avif');
    encodeHdrRendition(linear, null, { variant: 'pq', medium: 'still', outputPath, peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.99, crf: 40, preset: 12, maxEdge: MAX_EDGE });
    // The y4m is uncompressed 10-bit, so a leaked one is tens of megabytes per
    // photo sitting next to the output that replaced it.
    expect(await Bun.file(`${outputPath}.y4m`).exists()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an 8-bit decode is refused rather than encoded as something HDR-shaped', () => {
  // The samples would be read as 16-bit and half the frame would come out noise, so
  // this has to fail loudly rather than write a plausible-looking file.
  const image = decodeRawImage(FIXTURE, 8, 'srgb', MAX_EDGE);
  try {
    expect(() =>
      encodeHdrRendition(image, null, {
        variant: 'pq',
        medium: 'still',
        outputPath: '/tmp/never.avif',
        peakNits: 1000,
        referenceWhiteNits: 203,
        whiteQuantile: 0.99,
        crf: 40,
        preset: 12,
        maxEdge: MAX_EDGE,
      }),
    ).toThrow(/16-bit/);
  } finally {
    freeImage(image);
  }
});

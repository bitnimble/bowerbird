// The HDR still is a third decode path (scene-linear, Rec.2020, no auto-bright)
// feeding ffmpeg. Whether it is actually HDR is invisible until it reaches a
// display, so what is checkable here is that the pixels are scene-referred and
// that the file says what it must say (§10.7).
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeHdrVideo } from '../../src/services/processing/hdr_video';
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

test('the encoded still declares BT.2020 and PQ, which no encoder option alone achieves', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const image = decodeRaw(FIXTURE, 16, 'rec2020-linear');
    const outputPath = path.join(dir, 'pq.mp4');
    await encodeHdrVideo(image, { variant: 'pq', outputPath, peakNits: 1000, crf: 40, preset: 12, maxEdge: 3840 });

    const stream = probe(outputPath);
    expect(stream.color_primaries).toBe('bt2020');
    expect(stream.color_transfer).toBe('smpte2084');
    expect(stream.color_space).toBe('bt2020nc');
    // 8-bit would band visibly in the shadows a PQ curve stretches.
    expect(stream.pix_fmt).toBe('yuv420p10le');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the SDR reference is tagged BT.709 so it can be compared against', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-hdr-'));
  try {
    const image = decodeRaw(FIXTURE, 16, 'rec2020-linear');
    const outputPath = path.join(dir, 'sdr.mp4');
    await encodeHdrVideo(image, { variant: 'sdr', outputPath, peakNits: 1000, crf: 40, preset: 12, maxEdge: 3840 });

    const stream = probe(outputPath);
    expect(stream.color_primaries).toBe('bt709');
    expect(stream.color_transfer).toBe('bt709');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an 8-bit decode is refused rather than encoded as something HDR-shaped', async () => {
  const image = decodeRaw(FIXTURE, 8);
  await expect(
    encodeHdrVideo(image, { variant: 'pq', outputPath: '/tmp/never.mp4', peakNits: 1000, crf: 40, preset: 12, maxEdge: 3840 }),
  ).rejects.toThrow('16-bit');
});

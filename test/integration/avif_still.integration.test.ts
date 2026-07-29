// The HDR still is encoded by libavif in this process rather than by spawning ffmpeg
// and avifenc (DESIGN §10.7). avifenc is a wrapper around the same library, so the two
// should agree - but "should" is doing a lot of work there: the linked path applies the
// PQ transfer itself where zscale used to, and hands libavif 16-bit RGB where avifenc
// hands it a y4m that is already YCbCr.
//
// So it is pinned against the binary rather than argued about. `BOWERBIRD_AVIFENC=1`
// puts the encode back on the child processes, and what has to match is everything a
// browser reads: the dimensions, the pixel format, the range, and the CICP - the last
// of which is the whole reason libavif is here rather than ffmpeg's avif muxer.
//
// The pixels are compared rather than hashed. They are not bit-identical and should not
// be expected to be: the linked path quantises to 16-bit PQ before libavif converts to
// 10-bit YCbCr, where zscale goes straight there, and that intermediate step costs
// about a code value. What matters is that it is about a code value and not a picture.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

const PROBE = `
import { decodeRawImage, encodeHdrRendition, freeImage } from '${import.meta.dir}/../../src/services/processing/rawshim_ops';
const [file, out, medium, variant] = process.argv.slice(-4);
const image = decodeRawImage(file, 16, 'rec2020-linear', 640);
try {
  encodeHdrRendition(image, null, {
    variant, medium, outputPath: out, peakNits: 1000, referenceWhiteNits: 203,
    whiteQuantile: 0.9, crf: 30, preset: 10, maxEdge: 640,
  });
} finally {
  freeImage(image);
}
`;

async function encode(out: string, medium: string, viaAvifenc: boolean, variant = 'pq'): Promise<void> {
  const child = Bun.spawn(['bun', '-e', PROBE, '--', FIXTURE, out, medium, variant], {
    env: { ...process.env, ...(viaAvifenc ? { BOWERBIRD_AVIFENC: '1' } : {}), LOG_LEVEL: 'warn' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`encode failed: ${err}`);
}

function probe(file: string): string {
  const result = Bun.spawnSync([
    'ffprobe', '-hide_banner', '-loglevel', 'error',
    '-show_entries', 'stream=width,height,pix_fmt,color_range,color_primaries,color_transfer,color_space',
    '-of', 'default=nw=1', file,
  ]);
  if (result.exitCode !== 0) throw new Error(`ffprobe failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** Mean PSNR between two encodes of the same frame, in dB. Infinity when identical. */
function psnr(a: string, b: string): number {
  const result = Bun.spawnSync([
    'ffmpeg', '-hide_banner', '-loglevel', 'info', '-i', a, '-i', b,
    '-lavfi', '[0:v]format=yuv444p10le[x];[1:v]format=yuv444p10le[y];[x][y]psnr', '-f', 'null', '-',
  ]);
  const found = /average:([0-9.]+|inf)/.exec(result.stderr.toString());
  if (found == null) throw new Error(`no psnr in ffmpeg output: ${result.stderr.toString().slice(-400)}`);
  return found[1] === 'inf' ? Number.POSITIVE_INFINITY : Number(found[1]);
}

// Both media, because they differ in the one field most easily got wrong: the baseline
// control is 4:2:0 where the still is 4:4:4, and libavif takes that as a pixel format
// on the image rather than as a flag beside it.
for (const medium of ['still', 'still-baseline'] as const) {
  test(
    `the linked encoder agrees with avifenc, ${medium}`,
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bb-avif-'));
      try {
        const linked = path.join(dir, 'linked.avif');
        const spawned = path.join(dir, 'spawned.avif');
        await encode(linked, medium, false);
        await encode(spawned, medium, true);

        // Everything a browser reads to decide what the file is, including the CICP
        // that decides whether it is treated as HDR at all.
        expect(probe(linked)).toBe(probe(spawned));
        expect(probe(linked)).toContain(medium === 'still' ? 'pix_fmt=yuv444p10le' : 'pix_fmt=yuv420p10le');
        expect(probe(linked)).toContain('color_transfer=smpte2084');
        expect(probe(linked)).toContain('color_primaries=bt2020');

        // ~1 code value at 10 bits is the intermediate quantisation; a picture apart
        // would be tens of dB below this.
        const score = psnr(linked, spawned);
        expect(score).toBeGreaterThan(50);
        // Not infinite, because infinite means both runs took the same path and this
        // compared a file with itself. That is how a differential test dies quietly:
        // rename the environment variable, or let the guard in `encode_graded` start
        // declining, and every assertion above still passes having tested nothing.
        expect(score).not.toBe(Number.POSITIVE_INFINITY);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
}

/** Mean of the decoded frame as 8-bit grey, which is enough to catch a wrong transfer. */
function meanLuma(file: string): number {
  const out = Bun.spawnSync(['ffmpeg', '-hide_banner', '-v', 'error', '-i', file, '-vf', 'format=gray', '-f', 'rawvideo', '-']);
  if (out.exitCode !== 0) throw new Error(`decode failed: ${out.stderr.toString()}`);
  let sum = 0;
  for (const byte of out.stdout) sum += byte;
  return sum / out.stdout.length;
}

// The SDR reference does NOT go through the linked encoder, and this is what says so.
//
// It shipped broken for exactly one commit: `encode_graded` sent every still to
// libavif, which applies PQ unconditionally and converts no primaries, so the control
// came out PQ-encoded and tagged sRGB, on Rec.2020 pixels labelled BT.709. White
// rendered at about half luminance. Every assertion in the tests above passed, because
// the tagging was right and the tagging was all they read - and the pair test above
// only ever encodes PQ, so it never touched the broken path.
//
// A mean is a blunt instrument and deliberately so: the failure is a whole transfer
// curve, which moves it a quarter of the range, not a rounding difference. The two
// figures pinned here sit far enough apart to tell the curves apart and are loose
// enough not to move with an encoder revision.
test('the SDR reference is an ordinary picture, not a PQ one wearing an sRGB tag', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bb-avif-sdr-'));
  try {
    const sdr = path.join(dir, 'sdr.avif');
    const pq = path.join(dir, 'pq.avif');
    await encode(sdr, 'still', false, 'sdr');
    await encode(pq, 'still', false, 'pq');

    // Measured at 146.5 correct. Encoded through the PQ path instead it lands at or
    // below the PQ still's own 112, since PQ puts a 1000-nit peak at 0.75 of range
    // and the sRGB EOTF then reads that back as ~0.52.
    expect(meanLuma(sdr)).toBeGreaterThan(130);
    expect(meanLuma(sdr)).toBeLessThan(165);
    // And it must differ from the PQ still, or the two are the same file and the
    // control is not controlling for anything.
    expect(Math.abs(meanLuma(sdr) - meanLuma(pq))).toBeGreaterThan(10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

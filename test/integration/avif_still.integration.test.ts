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
import { _for_testing_encodeHdr } from '${import.meta.dir}/../../src/services/processing/rawshim_for_testing';
const [file, out, medium, chroma] = process.argv.slice(-4);
_for_testing_encodeHdr(file, {
  medium, outputPath: out, peakNits: 1000, referenceWhiteNits: 203,
  whiteQuantile: 0.9, crf: 30, preset: 10, maxEdge: 640,
  stillFullChroma: chroma === '444',
}, { decodeSize: 640 });
`;

async function encode(out: string, medium: string, viaAvifenc: boolean, chroma: string): Promise<void> {
  const child = Bun.spawn(['bun', '-e', PROBE, '--', FIXTURE, out, medium, chroma], {
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

// Both chroma settings, because they are two different agreements. The linked path
// reads the format off `avifImage`, the spawned one gets it from the y4m zscale wrote
// and an `--yuv` flag that has to say the same thing - and passing 444 while feeding a
// 4:2:0 y4m silently encoded 4:2:0 anyway, which is how the subsampling went unnoticed
// once (`hdr_args.rs`).
for (const [chroma, pixFmt] of [
  ['420', 'pix_fmt=yuv420p10le'],
  ['444', 'pix_fmt=yuv444p10le'],
] as const) {
  test(
    `the linked encoder agrees with avifenc, ${chroma}`,
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bb-avif-'));
      try {
        const linked = path.join(dir, 'linked.avif');
        const spawned = path.join(dir, 'spawned.avif');
        await encode(linked, 'still', false, chroma);
        await encode(spawned, 'still', true, chroma);

        // Everything a browser reads to decide what the file is, including the CICP
        // that decides whether it is treated as HDR at all.
        expect(probe(linked)).toBe(probe(spawned));
        expect(probe(linked)).toContain(pixFmt);
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


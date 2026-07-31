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
// The pixels are compared rather than hashed, and at 4:4:4 they now come out identical.
// They did not always: the linked path used to apply the PQ transfer itself where
// zscale applied the spawned one's, and that intermediate quantisation cost about a code
// value. Both media take the transfer on this side now (`tone::encode_pq`), so the two
// arms are handed the same PQ samples and differ only in who converts them to YCbCr -
// which at 4:4:4 is the same matrix on the same numbers. 4:2:0 still parts company,
// zscale and libavif subsampling chroma their own ways.
//
// Which means nothing about the *output* can tell a real comparison from one arm
// compared with itself, so the route is asserted directly.
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

const PROBE = `
import { _for_testing_encodeHdr } from '${import.meta.dir}/../../src/services/processing/rawshim_for_testing';
const [file, out, medium, chroma] = process.argv.slice(-4);
const outcome = _for_testing_encodeHdr(file, {
  medium, outputPath: out, peakNits: 1000, referenceWhiteNits: 203,
  whiteQuantile: 0.9, crf: 30, preset: 10, maxEdge: 640,
  stillFullChroma: chroma === '444',
}, { decodeSize: 640 });
console.log(outcome.usedAvifenc ? 'avifenc' : 'linked');
`;

/** Encodes one still, and reports which route the library says it took. */
async function encode(out: string, medium: string, viaAvifenc: boolean, chroma: string): Promise<string> {
  const child = Bun.spawn(['bun', '-e', PROBE, '--', FIXTURE, out, medium, chroma], {
    env: { ...process.env, ...(viaAvifenc ? { BOWERBIRD_AVIFENC: '1' } : {}), LOG_LEVEL: 'warn' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [route, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`encode failed: ${err}`);
  return route.trim();
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
        // First, that there are two routes at all. Rename the environment variable or
        // let the guard in `encode_frame` start declining, and every assertion below
        // still passes having compared a file with itself.
        expect(await encode(linked, 'still', false, chroma)).toBe('linked');
        expect(await encode(spawned, 'still', true, chroma)).toBe('avifenc');

        // Everything a browser reads to decide what the file is, including the CICP
        // that decides whether it is treated as HDR at all.
        expect(probe(linked)).toBe(probe(spawned));
        expect(probe(linked)).toContain(pixFmt);
        expect(probe(linked)).toContain('color_transfer=smpte2084');
        expect(probe(linked)).toContain('color_primaries=bt2020');

        // Identical at 4:4:4, both converting the same PQ samples with the same matrix.
        // At 4:2:0 the chroma subsampling is each library's own, and what has to hold
        // is that the difference stays around a code value rather than a picture.
        const score = psnr(linked, spawned);
        if (chroma === '444') {
          expect(score).toBe(Number.POSITIVE_INFINITY);
        } else {
          expect(score).toBeGreaterThan(50);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
}


// What a browser reads off an HDR still, read back with a decoder that is not ours
// (DESIGN §10.7). The dimensions and the pixel format would surface as a broken picture;
// the CICP triple would not - a file missing it decodes perfectly and is simply not HDR,
// which is the whole reason libavif writes these rather than ffmpeg's avif muxer, and
// the reason this is asserted against a real file rather than against the argument that
// set it.
//
//   docker exec bowerbird-dev bun test test/integration
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _for_testing_encodeHdr } from '../../src/services/processing/rawshim/rawshim_for_testing';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;

function probe(file: string): string {
  const result = Bun.spawnSync([
    'ffprobe', '-hide_banner', '-loglevel', 'error',
    '-show_entries', 'stream=width,height,pix_fmt,color_range,color_primaries,color_transfer,color_space',
    '-of', 'default=nw=1', file,
  ]);
  if (result.exitCode !== 0) throw new Error(`ffprobe failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

// Both chroma settings, because the format is read off `avifImage` rather than derived,
// and 4:2:0 is the only one that can round a dimension away (`hdr_args.rs`).
for (const [chroma, pixFmt] of [
  ['420', 'pix_fmt=yuv420p12le'],
  ['444', 'pix_fmt=yuv444p12le'],
] as const) {
  test(
    `an HDR still is tagged as one, ${chroma}`,
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'bb-avif-'));
      try {
        const out = path.join(dir, 'still.avif');
        _for_testing_encodeHdr(FIXTURE, {
          outputPath: out, peakNits: 1000, referenceWhiteNits: 203,
          whiteQuantile: 0.9, crf: 30, preset: 10, maxEdge: 640,
          stillFullChroma: chroma === '444',
        }, { decodeSize: 640 });

        const read = probe(out);
        expect(read).toContain(pixFmt);
        expect(read).toContain('color_range=tv');
        expect(read).toContain('color_transfer=smpte2084');
        expect(read).toContain('color_primaries=bt2020');
        expect(read).toContain('color_space=bt2020nc');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );
}

// What an HDR rendition costs end to end, matched and not, at the two sizes the
// product actually builds.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeHdr } from './src/services/processing/hdr_media';
import { fitHdrColour } from './src/services/processing/hdr_match';
import { fitMatchProfile } from './src/services/processing/jpeg_match';
import { decodeRaw, readEmbeddedJpeg } from './src/services/processing/raw_decoder';
import { diffuseWhite } from './src/services/processing/tone_map';

const RAW = '.photos/Test/DSC03438.ARW';
const dir = mkdtempSync(path.join(tmpdir(), 'bb-perf-'));

const linear = decodeRaw(RAW, 16, 'rec2020-linear');
const profile = await fitMatchProfile(RAW, decodeRaw(RAW, 8));
const jpeg = readEmbeddedJpeg(RAW);
const colour = profile && jpeg ? await fitHdrColour(linear, diffuseWhite(linear, 0.9), jpeg, profile) : null;
console.log(`${linear.width}x${linear.height}, match ${colour == null ? 'none' : `dE ${colour.deltaE.toFixed(2)}`}\n`);

console.log('rendition          match    encode   output');
for (const [label, maxEdge] of [
  ['full  (3840)', 3840],
  ['max   (native)', Number.POSITIVE_INFINITY],
] as const) {
  for (const [name, match] of [
    ['off', null],
    ['on ', colour],
  ] as const) {
    const out = path.join(dir, `${maxEdge}-${name.trim()}.avif`);
    const t = Date.now();
    await encodeHdr(linear, {
      variant: 'pq',
      medium: 'still',
      outputPath: out,
      peakNits: 1000,
      referenceWhiteNits: 203,
      whiteQuantile: 0.9,
      match,
      crf: 20,
      preset: 8,
      maxEdge,
    });
    const mb = (statSync(out).size / 1e6).toFixed(1);
    console.log(`${label.padEnd(18)} ${name}    ${((Date.now() - t) / 1000).toFixed(1).padStart(5)}s   ${mb} MB`);
  }
}
rmSync(dir, { recursive: true, force: true });

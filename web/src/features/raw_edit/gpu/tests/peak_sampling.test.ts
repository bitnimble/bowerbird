// Which pixels the peak reads, held to the other host's answer.
//
// Both hosts run `peak.wgsl` over the frame the shader grades, every nth row - but the stride
// is the host's to compute, and the two computing it differently is a divergence nothing else
// can catch. The graded parity fixtures are 6144 pixels, where both return a stride of 1 and
// read every pixel, so a host that changed how it sampled would reproduce every committed byte
// and still measure a different peak on any real photograph. A different peak is a different
// place for the roll-off knee, which is a visible difference in the highlights between a
// rendition and what the editor showed.
//
// `native/rawshim/tests/gpu_fixture.rs` writes the file and asserts its own half.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { peakSampling } from '../shaders';

const TABLE = join(import.meta.dir, '..', '..', '..', '..', '..', 'e2e', 'fixtures', 'gpu', 'peak-sampling.txt');

test('the peak samples the same pixels here as it does natively', () => {
  const rows = readFileSync(TABLE, 'utf8').trim().split('\n');
  expect(rows.length).toBeGreaterThan(0);
  const built = rows.map((row) => {
    const found = /^(\d+)x(\d+) stride \d+ samples \d+$/.exec(row);
    expect(found, `${row} is not a row this knows how to read`).not.toBeNull();
    const width = Number(found?.[1]);
    const height = Number(found?.[2]);
    const { rowStride, peakSamples } = peakSampling(width, height);
    return `${width}x${height} stride ${rowStride} samples ${peakSamples}`;
  });
  expect(built).toEqual(rows);
});

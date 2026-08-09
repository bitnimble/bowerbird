// The two lengths the peak's shader and the host both declare.
//
// They used to be pipeline-overridable, which made them one number by construction. They cannot
// be: WebKit refuses a pipeline handed a constant its entry point does not statically reference,
// and neither `measure` nor `collect` reads both - so every RAW refused to open on Safari with
// "Compute library failed creation". Declared on each side instead, and held together here,
// because the failure they guard is silent otherwise: a histogram longer than its buffer is a
// dropped dispatch and a black canvas, not an error.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DETAIL_LONG, PEAK_BINS, PEAK_CANDIDATES } from '../shaders';

const wgsl = (name: string): string =>
  readFileSync(join(import.meta.dir, '..', 'wgsl', name), 'utf8');
const source = wgsl('peak.wgsl');

function declared(name: string, from = source): number {
  const found = new RegExp(`^const ${name}: u32 = (\\d+)u;$`, 'm').exec(from);
  expect(found, `${name} is no longer declared where this looks for it`).not.toBeNull();
  return Number(found?.[1]);
}

describe("the peak's lengths", () => {
  test('are the same on both sides', () => {
    expect(declared('BINS')).toBe(PEAK_BINS);
    expect(declared('CANDIDATES')).toBe(PEAK_CANDIDATES);
  });

  // An `override` here is only sound if every entry point in the module reads it, which is not
  // a property anyone editing the shader would think to preserve.
  test('are not overridable, which is what Safari refuses', () => {
    expect(source).not.toMatch(/^override /m);
  });
});

// Not a buffer length but the same shape of failure, and a worse one to find: this sets how
// large a share of the picture each blur covers, so a host that sized the texture differently
// blurs at a different scale. Both pictures still look like pictures - the editor's clarity
// and the rendition's would simply not be the same edit. `gpu.rs` pins its own copy.
test("the detail blur's working size is the same on both sides", () => {
  expect(declared('DETAIL_LONG', wgsl('detail.wgsl'))).toBe(DETAIL_LONG);
});

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
import { PEAK_BINS, PEAK_CANDIDATES } from '../shaders';

const source = readFileSync(join(import.meta.dir, '..', 'wgsl', 'peak.wgsl'), 'utf8');

function declared(name: string): number {
  const found = new RegExp(`^const ${name}: u32 = (\\d+)u;$`, 'm').exec(source);
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

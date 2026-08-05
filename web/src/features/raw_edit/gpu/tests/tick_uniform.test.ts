// The one struct written on one side of the boundary and read on the other.
//
// `TICK_LAYOUT` is the host's copy of `struct Tick`, and a copy is what this exists for: the
// shader declares the fields, the host writes them by offset, and nothing connected the two.
// Most of the struct is covered by accident - `gpu_parity` reads back `encode`, which touches
// everything up to `level_scale` - but the tail is read only by the draw, and no test looks at
// a drawn pixel. Swap `region_size` and `canvas_size` in the WGSL, or insert one scalar before
// `region_origin` and push both vectors off the 8-byte boundary they need, and every suite
// stays green while the editor draws the wrong rectangle at the wrong mip on every zoom.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TICK_LAYOUT, TICK_UNIFORM_FLOATS, tickOffsets } from '../shaders';

/** `struct Tick`'s members, in order, read out of the shader that owns them. */
function declared(): [string, string][] {
  const source = readFileSync(join(import.meta.dir, '..', 'wgsl', 'tick.wgsl'), 'utf8');
  const body = /struct Tick \{([\s\S]*?)\n\};/.exec(source);
  expect(body).not.toBeNull();
  return (body?.[1] ?? '')
    .split('\n')
    .map((line) => /^\s*([a-z_0-9]+)\s*:\s*([a-z0-9]+)\s*,/.exec(line))
    .filter((match): match is RegExpExecArray => match != null)
    .map((match) => [match[1] ?? '', match[2] ?? '']);
}

describe('the Tick uniform', () => {
  test('is declared here in the order the shader declares it', () => {
    // Both halves as one comparison, so a failure prints the two lists side by side and says
    // which field moved rather than only that a count is wrong.
    expect(TICK_LAYOUT.map(([name, type]) => `${name}: ${type}`)).toEqual(
      declared().map(([name, type]) => `${name}: ${type}`),
    );
  });

  // WGSL rounds a `vec2f` up to a multiple of two words. The host writes into a flat
  // `Float32Array`, so an unaligned vector is not an error anywhere - it is six floats landing
  // one slot from where the shader reads them, which is a region and a canvas size read as
  // each other's halves.
  test('puts every vector where the shader will look for it', () => {
    const { at } = tickOffsets();
    for (const [name, type] of TICK_LAYOUT) {
      if (type !== 'vec2f') continue;
      expect(`${name} at ${at[name]}`).toBe(`${name} at ${Math.ceil(at[name] / 2) * 2}`);
    }
  });

  test('fits the buffer it is written into, rounded to the 16 bytes a uniform wants', () => {
    const words = TICK_LAYOUT.reduce((n, [, type]) => n + (type === 'vec2f' ? 2 : 1), 0);
    expect(TICK_UNIFORM_FLOATS % 4).toBe(0);
    expect(TICK_UNIFORM_FLOATS).toBeGreaterThanOrEqual(words);
    // And no slacker than it has to be, or the padding is hiding a field somebody removed.
    expect(TICK_UNIFORM_FLOATS - words).toBeLessThan(4);
  });

  // The reason `pad0` is in the struct at all, which its comment states and nothing checked.
  test('keeps the padding that is load-bearing', () => {
    const withoutPad0 = TICK_LAYOUT.filter(([name]) => name !== 'pad0');
    let next = 0;
    let misaligned = 0;
    for (const [, type] of withoutPad0) {
      if (type === 'vec2f' && next % 2 !== 0) misaligned++;
      if (type === 'vec2f') next = Math.ceil(next / 2) * 2;
      next += type === 'vec2f' ? 2 : 1;
    }
    // Not a tautology: it says the field earns its place. Remove it and the vectors shift.
    expect(misaligned).toBeGreaterThan(0);
  });
});

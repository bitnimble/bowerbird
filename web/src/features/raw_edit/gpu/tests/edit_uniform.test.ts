// The one struct written on one side of the boundary and read on the other.
//
// `EDIT_LAYOUT` is the host's copy of `struct Edit`, and a copy is what this exists for: the
// shader declares the fields, the host writes them by offset, and nothing connected the two.
// Most of the struct is covered by accident - `gpu_parity` reads back `encode`, which touches
// everything up to `level_scale` - but the tail is read only by the draw, and no test looks at
// a drawn pixel. Swap `region_size` and `canvas_size` in the WGSL, or insert one scalar before
// `region_origin` and push both vectors off the 8-byte boundary they need, and every suite
// stays green while the editor draws the wrong rectangle at the wrong mip on every zoom.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDIT_LAYOUT, EDIT_UNIFORM_FLOATS, editOffsets } from '../shaders';

/**
 * `struct Edit`'s members, in order, read out of the shader that owns them.
 *
 * What it could not read comes back too, and is asserted on. A parser that drops what it does
 * not recognise turns the comparison below into a comparison of two subsets: a field added to
 * the WGSL in a spelling this misses is absent from both lists, so the parity test passes
 * while the host never writes the field at all. Silence is the failure mode to design out.
 */
function declared(): { members: [string, string][]; unread: string[] } {
  const source = readFileSync(join(import.meta.dir, '..', 'wgsl', 'edit.wgsl'), 'utf8');
  const body = /struct Edit \{([\s\S]*?)\n\};/.exec(source);
  expect(body, 'struct Edit is no longer where this looks for it').not.toBeNull();

  const members: [string, string][] = [];
  const unread: string[] = [];
  for (const line of (body?.[1] ?? '').split('\n')) {
    const bare = line.trim();
    if (bare === '' || bare.startsWith('//')) continue;
    const member = /^([A-Za-z_][A-Za-z_0-9]*)\s*:\s*([^,]+?),?$/.exec(bare);
    if (member == null) {
      unread.push(bare);
      continue;
    }
    // `vec2<f32>` and `vec2f` are one type spelled two ways, and this is about the layout
    // rather than the spelling.
    members.push([member[1] ?? '', (member[2] ?? '').replace(/^vec([234])<f32>$/, 'vec$1f')]);
  }
  return { members, unread };
}

describe('the Edit uniform', () => {
  test('is read whole out of the shader', () => {
    const { members, unread } = declared();
    expect(unread, 'a member this cannot parse is a member the check below ignores').toEqual([]);
    expect(members.length).toBe(EDIT_LAYOUT.length);
  });

  test('is declared here in the order the shader declares it', () => {
    // Both halves as one comparison, so a failure prints the two lists side by side and says
    // which field moved rather than only that a count is wrong.
    expect(EDIT_LAYOUT.map(([name, type]) => `${name}: ${type}`)).toEqual(
      declared().members.map(([name, type]) => `${name}: ${type}`),
    );
  });

  // WGSL rounds a `vec2f` up to a multiple of two words, and the host writes into a flat
  // `Float32Array` where an unaligned vector is not an error anywhere - it is six floats
  // landing one slot from where the shader reads them, which is a region and a canvas size
  // read as each other's halves.
  //
  // Computed from the shader's own declaration rather than from `EDIT_LAYOUT`, because
  // `editOffsets` rounds vectors up by construction: asked where it put one, it can only
  // answer with a number it has already rounded. The question worth asking is whether the two
  // sources agree, so the offsets are derived here from the `.wgsl` and held against the ones
  // the host writes by.
  test('agrees with the shader about where every field starts', () => {
    const { at } = editOffsets();
    let next = 0;
    for (const [name, type] of declared().members) {
      if (type === 'vec2f') next = Math.ceil(next / 2) * 2;
      expect(`${name} at ${at[name as keyof typeof at]}`).toBe(`${name} at ${next}`);
      next += type === 'vec2f' ? 2 : 1;
    }
  });

  test('fits the buffer it is written into, rounded to the 16 bytes a uniform wants', () => {
    const words = EDIT_LAYOUT.reduce((n, [, type]) => n + (type === 'vec2f' ? 2 : 1), 0);
    expect(EDIT_UNIFORM_FLOATS % 4).toBe(0);
    expect(EDIT_UNIFORM_FLOATS).toBeGreaterThanOrEqual(words);
    // And no slacker than it has to be, or the padding is hiding a field somebody removed.
    expect(EDIT_UNIFORM_FLOATS - words).toBeLessThan(4);
  });
});

import { expect, test } from 'bun:test';
import STAGE_WGSL from '../../generated/stage.wgsl?raw';
import { colourWords } from '../stage_gpu';

// `Colour` is written by TypeScript and read by WGSL, so its packing exists in two places and this
// is the pin. Both traps are silent: a field out of order is a wrong picture, and a buffer shorter
// than the struct - which std140 rounds up to its 16-byte alignment - is a draw that never happens.
test('the colour words are the fields the emitted WGSL declares, in its order and size', () => {
  const words = colourWords(2, [0.5, 0.25], { depth: 4, chroma: 0.5 }, [3, -2], 1.5, 180, 3, 4.9);
  expect(Array.from(words)).toEqual([2, 203, 0.5, 0.25, 4, 0.5, 3, -2, 1.5, 180, 3, Math.fround(4.9)]);

  const block = STAGE_WGSL.match(/struct Colour[^{]*\{([^}]*)\}/)?.[1] ?? '';
  const fields = [...block.matchAll(/@align\((\d+)\)\s+(\w+)_\d+\s*:\s*([\w<>]+)/g)];
  expect(fields.map((field) => field[2])).toEqual(
    ['headroom', 'reference', 'sample', 'depth', 'chroma', 'shift', 'gain', 'rotation', 'proof', 'source_peak']);

  // std140 layout of what was declared, with the struct rounded to its widest alignment.
  let end = 0;
  let widest = 0;
  for (const [, align, , type] of fields) {
    const alignment = Number(align);
    widest = Math.max(widest, alignment);
    end = Math.ceil(end / alignment) * alignment + (type!.startsWith('vec2') ? 8 : 4);
  }
  expect(words.byteLength).toBeGreaterThanOrEqual(Math.ceil(end / widest) * widest);
});

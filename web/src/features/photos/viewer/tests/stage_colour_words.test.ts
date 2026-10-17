import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Finish, PlanesLayout } from '../../../../avif/avif_planes';
import STAGE_WGSL from '../../generated/stage.wgsl?raw';
import { colourWords, finishWords } from '../stage_gpu';

// `static const` folds into the WGSL, so the mode numbers are read from their Slang.
const GAIN_MAP_SLANG = readFileSync(
  `${import.meta.dir}/../../../../../../slang/gain_map.slang`,
  'utf8',
);
const gainMode = (name: string): number =>
  Number(GAIN_MAP_SLANG.match(new RegExp(`${name} = (\\d+);`))?.[1]);
const GAIN_ISO = gainMode('GAIN_ISO');
const GAIN_APPLE = gainMode('GAIN_APPLE');

// `Colour` is written by TypeScript and read by WGSL, so its packing exists in two places and this
// is the pin. Both traps are silent: a field out of order is a wrong picture, and a buffer shorter
// than the struct - which std140 rounds up to its 16-byte alignment - is a draw that never happens.
test('the colour words are the fields the emitted WGSL declares, in its order and size', () => {
  const words = colourWords(2, [0.5, 0.25], { depth: 4, chroma: 0.5 }, [3, -2], 1.5, 180, 3, 4.9);
  expect(Array.from(words)).toEqual([
    2,
    203,
    0.5,
    0.25,
    4,
    0.5,
    3,
    -2,
    1.5,
    180,
    3,
    Math.fround(4.9),
  ]);

  const block = STAGE_WGSL.match(/struct Colour[^{]*\{([^}]*)\}/)?.[1] ?? '';
  const fields = [...block.matchAll(/@align\((\d+)\)\s+(\w+)_\d+\s*:\s*([\w<>]+)/g)];
  expect(fields.map((field) => field[2])).toEqual([
    'headroom',
    'reference',
    'sample',
    'depth',
    'chroma',
    'shift',
    'gain',
    'rotation',
    'proof',
    'source_peak',
  ]);

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

test('the finish words are the vec4s the emitted WGSL declares, in its order', () => {
  const block = STAGE_WGSL.match(/struct Finish_std140[^{]*\{([^}]*)\}/)?.[1] ?? '';
  const fields = [...block.matchAll(/(\w+)_\d+\s*:\s*([\w<>]+)/g)];
  expect(fields.map((field) => field[1])).toEqual([
    'row0',
    'row1',
    'row2',
    'signal',
    'placed',
    'arrangement',
    'gain_signal',
    'gain_shape',
    'gain_min',
    'gain_max',
    'gain_gamma',
    'offset_base',
    'offset_alternate',
  ]);
  expect(fields.every((field) => field[2] === 'vec4<f32>')).toBe(true);

  const words = finishWords(
    {
      signal: { kr: 0.299, kb: 0.114, fullRange: true, depth: 10 },
      matrix: [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      table: new Float32Array(3),
      gain: {
        picture: {
          samples: new Uint8Array(),
          layout: {
            width: 1000,
            height: 750,
            bits: 8,
            subsampled: false,
            planes: [{ offset: 0, stride: 4000 }],
          },
        },
        signal: { kr: 0.2126, kb: 0.0722, fullRange: false, depth: 8 },
        terms: {
          mode: 'iso',
          min: [0, 0, 0],
          max: [2.5, 2.5, 2.5],
          gamma: [1, 1, 1],
          offsetBase: [0.25, 0.25, 0.25],
          offsetAlternate: [0.5, 0.5, 0.5],
        },
      },
    },
    {
      width: 4000,
      height: 3000,
      bits: 8,
      subsampled: true,
      planes: [
        { offset: 0, stride: 0 },
        { offset: 0, stride: 0 },
      ],
    },
    { x: 512, y: 1024, width: 4000, height: 3000 },
  );
  expect(words.byteLength).toBe(fields.length * 16);
  expect(vecs(words)).toEqual([
    [1, 2, 3, 0],
    [4, 5, 6, 0],
    [7, 8, 9, 0],
    [Math.fround(0.299), Math.fround(0.114), 1, 1023],
    [512, 1024, 4000, 3000],
    [1, 2, 0, 0],
    [Math.fround(0.2126), Math.fround(0.0722), 0, 255],
    [1000, 750, GAIN_ISO, 1],
    [0, 0, 0, 0],
    [2.5, 2.5, 2.5, 0],
    [1, 1, 1, 0],
    [0.25, 0.25, 0.25, 0],
    [0.5, 0.5, 0.5, 0],
  ]);
});

test("the finish words carry Apple's headroom alone, and no map as -1 with neutral terms", () => {
  const base: PlanesLayout = {
    width: 4000,
    height: 3000,
    bits: 8,
    subsampled: true,
    planes: [
      { offset: 0, stride: 0 },
      { offset: 0, stride: 0 },
      { offset: 0, stride: 0 },
    ],
  };
  const finish: Finish = {
    signal: { kr: 0.299, kb: 0.114, fullRange: true, depth: 8 },
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    table: new Float32Array(3),
    gain: null,
  };
  const placed = { x: 0, y: 0, width: 4000, height: 3000 };
  const neutral = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [1, 1, 1, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];

  const none = vecs(finishWords(finish, base, placed));
  expect(none[5]).toEqual([0, 0, 0, 0]);
  expect(none[6]).toEqual([0, 0, 0, 0]);
  expect(none[7]).toEqual([0, 0, -1, 1]);
  expect(none.slice(8)).toEqual(neutral);

  const apple = vecs(
    finishWords(
      {
        ...finish,
        gain: {
          picture: { samples: new Uint8Array(), layout: { ...base, width: 1000, height: 750 } },
          signal: { kr: 0.299, kb: 0.114, fullRange: true, depth: 8 },
          terms: { mode: 'apple', headroom: 3.5 },
        },
      },
      base,
      placed,
    ),
  );
  expect(apple[7]).toEqual([1000, 750, GAIN_APPLE, 3.5]);
  expect(apple.slice(8)).toEqual(neutral);
});

function vecs(words: Float32Array): number[][] {
  return Array.from({ length: words.length / 4 }, (_, at) =>
    Array.from(words.subarray(at * 4, at * 4 + 4)),
  );
}

// Where each slider lands in the uniform, held to the other host's answer.
//
// Every *rule* about a document has one implementation - the frame's half of the uniform is
// built natively and copied here, and what a null or a stop means is the shader's. What is
// still written twice is the list of assignments: `gpu::uniform_words` puts each field in a
// slot, and `edits` does it again. Transposing a pair is a photograph graded with the
// clarity somebody asked for as texture, and nothing else would see it - the graded parity
// fixtures are pinned at every slider zero, where a transposition changes no byte.
//
// `native/rawshim/tests/gpu_fixture.rs` writes the file and asserts its own half.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDIT_UNIFORM_FLOATS, type EditAdjust, editOffsets, edits, wholeFrameGeometry } from '../shaders';

const TABLE = join(import.meta.dir, '..', '..', '..', '..', '..', 'e2e', 'fixtures', 'gpu', 'edit-words.txt');

/** The half of the uniform this side owns, at rest - which is where the native writer leaves it. */
const AT_REST = {
  region: { x: 0, y: 0, width: 0, height: 0 },
  canvas: { width: 0, height: 0 },
  maxLod: 0,
};

const balance = (field: string): number | null => (field === 'null' ? null : Number(field));

test('the editor fills an Edit the way the native writer does', () => {
  const rows = readFileSync(TABLE, 'utf8').trim().split('\n');
  expect(rows.length).toBeGreaterThan(0);

  for (const row of rows) {
    const [name, exposure, ...rest] = row.split(' ');
    const words = rest.pop() ?? '';
    const adjust: EditAdjust = {
      contrast: Number(rest[0]),
      highlights: Number(rest[1]),
      shadows: Number(rest[2]),
      whites: Number(rest[3]),
      blacks: Number(rest[4]),
      vibrance: Number(rest[5]),
      saturation: Number(rest[6]),
      texture: Number(rest[7]),
      clarity: Number(rest[8]),
      dehaze: Number(rest[9]),
      temperature: balance(rest[10] ?? 'null'),
      tint: balance(rest[11] ?? 'null'),
    };

    const want = words.split(',').map(Number);
    const built = Array.from(
      new Uint32Array(
        // The frame's own size, because the native writer leaves the geometry at its identity:
        // a rendition's crop happens in the gather, so the frame it grades is already cropped.
        edits(frameHalf(want), adjust, Number(exposure), AT_REST, wholeFrameGeometry(96, 64)).buffer,
      ),
    );
    expect(built, `${name} does not land where the native writer puts it`).toEqual(want);
  }
});

// The fixture above can only pin the geometry at its identity - a rendition's crop happens in
// the gather, so the native writer has none to write - and at the identity `crop_left` and
// `crop_top` hold the same 0, `crop_right` and `crop_bottom` the same 1. Swapping either pair
// leaves every row byte-identical, so the slots are named here instead, against the offsets the
// shader's own struct produces.
test('the geometry lands in the slots the struct names', () => {
  const at = editOffsets().at;
  const words = edits(
    Array.from<number>({ length: EDIT_UNIFORM_FLOATS }).fill(0),
    ADJUST_AT_REST,
    0,
    AT_REST,
    {
      cropLeft: 0.11,
      cropTop: 0.22,
      cropRight: 0.83,
      cropBottom: 0.94,
      cropAngle: 3.5,
      rotate: 270,
      output: { width: 41, height: 37 },
      keystone: [1.1, 0.2, 0.3, 0.4, 1.5, 0.6, 0.007, 0.008],
    },
  );
  const floats = new Float32Array(words.buffer);
  const ints = new Uint32Array(words.buffer);

  expect(floats[at.crop_left]).toBeCloseTo(0.11, 6);
  expect(floats[at.crop_top]).toBeCloseTo(0.22, 6);
  expect(floats[at.crop_right]).toBeCloseTo(0.83, 6);
  expect(floats[at.crop_bottom]).toBeCloseTo(0.94, 6);
  expect(floats[at.crop_angle]).toBeCloseTo(3.5, 6);
  expect(ints[at.rotate]).toBe(270);
  expect(ints[at.output_width]).toBe(41);
  expect(ints[at.output_height]).toBe(37);

  // Eight distinct values, in order, because the fixture carries the correction at its identity
  // too - eight zeros, where a transposed pair changes no byte. Nothing outside a GPU saw these
  // slots at all.
  for (const [element, value] of [1.1, 0.2, 0.3, 0.4, 1.5, 0.6, 0.007, 0.008].entries()) {
    expect(floats[at.keystone_0 + element], `keystone_${element}`).toBeCloseTo(value, 5);
  }
  expect(ints[at.has_keystone]).toBe(1);
});

test('says there is no correction when the document holds none', () => {
  const at = editOffsets().at;
  const words = edits(
    Array.from<number>({ length: EDIT_UNIFORM_FLOATS }).fill(0),
    ADJUST_AT_REST,
    0,
    AT_REST,
    wholeFrameGeometry(96, 64),
  );

  // The flag, not the eight: `geometry.wgsl` reads it to decide whether to look at them at all,
  // so a photograph nobody corrected must carry a zero here however the slots happen to read.
  expect(new Uint32Array(words.buffer)[at.has_keystone]).toBe(0);
});

const ADJUST_AT_REST: EditAdjust = {
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  temperature: null,
  tint: null,
};

/**
 * A case's words with everything `edits` fills in cleared, which is what a header carries.
 *
 * Taken from the committed answer rather than built here: this side has no camera match and no
 * levels to describe, which is exactly the point - it copies them. Clearing the reader's own
 * fields first is what stops this passing by handing `edits` the answer it is being asked
 * for, and clearing them *by name* is what keeps the frame's - the as-shot illuminant among
 * them - intact.
 */
function frameHalf(words: number[]): number[] {
  const at = editOffsets().at;
  const out = words.slice();
  const owned = [
    at.exposure,
    at.region_origin,
    at.region_origin + 1,
    at.region_size,
    at.region_size + 1,
    at.canvas_size,
    at.canvas_size + 1,
    at.max_lod,
    at.contrast,
    at.highlights,
    at.shadows,
    at.whites,
    at.blacks,
    at.vibrance,
    at.sat_adjust,
    at.texture_adjust,
    at.clarity,
    at.dehaze,
    at.temperature,
    at.tint,
    at.balance_set,
  ];
  for (const word of owned) out[word] = 0;
  return out;
}

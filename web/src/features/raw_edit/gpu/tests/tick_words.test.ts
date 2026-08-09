// Where each slider lands in the uniform, held to the other host's answer.
//
// Every *rule* about a document has one implementation - the frame's half of the uniform is
// built natively and copied here, and what a null or a stop means is the shader's. What is
// still written twice is the list of assignments: `gpu::uniform_words` puts each field in a
// slot, and `tickWords` does it again. Transposing a pair is a photograph graded with the
// clarity somebody asked for as texture, and nothing else would see it - the graded parity
// fixtures are pinned at every slider zero, where a transposition changes no byte.
//
// `native/rawshim/tests/gpu_fixture.rs` writes the file and asserts its own half.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TickAdjust, tickOffsets, tickWords } from '../shaders';

const TABLE = join(import.meta.dir, '..', '..', '..', '..', '..', 'e2e', 'fixtures', 'gpu', 'tick-words.txt');

/** The half of the uniform this side owns, at rest - which is where the native writer leaves it. */
const AT_REST = {
  region: { x: 0, y: 0, width: 0, height: 0 },
  canvas: { width: 0, height: 0 },
  maxLod: 0,
};

const balance = (field: string): number | null => (field === 'null' ? null : Number(field));

test('the editor fills a Tick the way the native writer does', () => {
  const rows = readFileSync(TABLE, 'utf8').trim().split('\n');
  expect(rows.length).toBeGreaterThan(0);

  for (const row of rows) {
    const [name, exposure, ...rest] = row.split(' ');
    const words = rest.pop() ?? '';
    const adjust: TickAdjust = {
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
      new Uint32Array(tickWords(frameHalf(want), adjust, Number(exposure), AT_REST).buffer),
    );
    expect(built, `${name} does not land where the native writer puts it`).toEqual(want);
  }
});

/**
 * A case's words with everything `tickWords` fills in cleared, which is what a header carries.
 *
 * Taken from the committed answer rather than built here: this side has no camera match and no
 * levels to describe, which is exactly the point - it copies them. Clearing the tick's own
 * fields first is what stops this passing by handing `tickWords` the answer it is being asked
 * for, and clearing them *by name* is what keeps the frame's - the as-shot illuminant among
 * them - intact.
 */
function frameHalf(words: number[]): number[] {
  const at = tickOffsets().at;
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

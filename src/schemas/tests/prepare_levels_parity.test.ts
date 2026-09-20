// Which level a picture is prepared at, held to the other host's answer.
//
// Two implementations of one arithmetic. This side picks the level and sizes the buffer the
// library writes into; `picture::prepared` produces the picture at that level. A buffer too small
// at least fails naming the size it wanted; a level too shallow is a picture no adapter will hold
// a texture of, which the client refuses after paying to fetch it.
//
// `native/rawshim/tests/gpu_fixture.rs` writes the file and asserts its own half, including that
// the ceiling below is still the one it carries.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COARSEST_LONG,
  MAX_LONG_EDGE,
  coarsestLevel,
  levelSize,
  longEdgeAt,
} from '../prepare_levels';

const TABLE = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'tables', 'prepare-levels.txt');

test('the server picks the level the native host produces', () => {
  const rows = readFileSync(TABLE, 'utf8')
    .trim()
    .split('\n')
    .filter((row) => !row.startsWith('shape '));
  expect(rows.length).toBeGreaterThan(0);

  for (const row of rows) {
    const [long = '', level = '', at = ''] = row.split(' ');
    expect(coarsestLevel(Number(long)), `the level for ${long}`).toBe(Number(level));
    expect(longEdgeAt(Number(long), Number(level)), `${long} at level ${level}`).toBe(Number(at));
  }
});

// **And what shape that level is, on both axes.** A window is stated in the level's own pixels and
// the library refuses one that is not inside them, so a server rounding either axis differently
// asks for a rectangle off the end of the picture - which a reader zoomed into the right-hand end
// of a panorama meets as an error rather than as a picture.
test('the server and the native host agree what shape a level is', () => {
  const rows = readFileSync(TABLE, 'utf8')
    .trim()
    .split('\n')
    .filter((row) => row.startsWith('shape '));
  expect(rows.length).toBeGreaterThan(0);

  for (const row of rows) {
    const [, wide = '', tall = '', level = '', width = '', height = ''] = row.split(' ');
    const size = levelSize(Number(wide), Number(tall), Number(level));
    const at = `${wide}x${tall} at level ${level}`;
    expect([size.width, size.height], at).toEqual([Number(width), Number(height)]);
  }
});

// A composite is never assembled wider than this, so the shallow levels of a very wide canvas are
// all the same shape - and a client halving past it would place every window at twice the
// coordinate the library reads.
test('the level stops halving where a composite stops being assembled', () => {
  const wide = levelSize(33804, 9376, 0);
  expect(Math.max(wide.width, wide.height)).toBeLessThanOrEqual(MAX_LONG_EDGE);
  expect(levelSize(33804, 9376, 1)).toEqual(wide);
});

test('the ceiling is the one both sides carry', () => {
  expect(COARSEST_LONG).toBe(4096);
  // Which is what makes every prepared picture fit the smallest texture limit WebGPU guarantees:
  // the blur the presence sliders read is built at half the frame, and 2048 is well inside 8192.
  expect(coarsestLevel(COARSEST_LONG)).toBe(0);
  expect(coarsestLevel(COARSEST_LONG + 1)).toBe(1);
});

// What a geometry does to a frame's shape, held to the other host's answer.
//
// **Three consumers and two implementations.** `hdr::cropped_size` decides what a rendition is
// written at; this side decides what shape the grid lays a tile out in, and what the editor sizes
// its stage to. `cropped_size`'s own doc has always said the two have to agree - "a disagreement is
// a tile that is the wrong shape for the picture inside it" - and until this file neither side
// asked the other.
//
// What that costs when it drifts is not an error anywhere: the catalogue lays out a tile at one
// aspect, the encoder writes a file at another, and every photograph in the library is letterboxed
// or stretched inside its own frame for as long as nobody looks closely.
//
// The negative angles are here because the two spell the absolute differently - Rust takes
// `cos().abs()` of the signed radians, this takes the cosine of `Math.abs(degrees)` - and the
// sub-pixel crop is here because both round and floor at one, which is where a `round` against a
// `floor` would first show.
//
// `native/rawshim/tests/gpu_fixture.rs` writes the file and asserts its own half.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { displaySize } from '../display_size';
import type { EditDoc } from '../photo_edits';

const TABLE = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'tables', 'display-size.txt');

test('the page shapes a geometry the way the native host does', () => {
  const rows = readFileSync(TABLE, 'utf8').trim().split('\n');
  expect(rows.length).toBeGreaterThan(0);

  for (const row of rows) {
    const [frame = '', crop = '', angle = '', rotate = '', want = ''] = row.split(' ');
    const [width = 0, height = 0] = frame.split('x').map(Number);
    const [left = 0, top = 0, right = 0, bottom = 0] = crop.split(',').map(Number);

    // Only the fields displaySize reads; the rest of an EditDoc does not reach the shape.
    const doc = {
      cropLeft: left,
      cropTop: top,
      cropRight: right,
      cropBottom: bottom,
      cropAngle: Number(angle),
      rotate: Number(rotate),
    } as EditDoc;

    const mine = displaySize(width, height, doc);
    expect(`${mine.width}x${mine.height}`).toBe(want);
  }
});

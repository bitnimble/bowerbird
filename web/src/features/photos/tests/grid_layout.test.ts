import { describe, expect, test } from 'bun:test';
import {
  BAND_PAD,
  BLOCK,
  GRID_GAP,
  MAX_SCROLL,
  bandRowHeight,
  blockTops,
  gridColumns,
  gridRowHeight,
  visibleBlocks,
} from '../grid_layout';

describe('gridColumns', () => {
  test('fits as many tiles of the minimum size as the width allows', () => {
    // Three 240px tiles and two gaps is 726, four would need 969.
    expect(gridColumns(969, 240)).toBe(4);
    expect(gridColumns(968, 240)).toBe(3);
  });

  test('never drops below one, however narrow', () => {
    expect(gridColumns(100, 1600)).toBe(1);
    expect(gridColumns(0, 240)).toBe(1);
  });
});

describe('gridRowHeight', () => {
  test('is the 3:2 cell plus the gap under it', () => {
    // Four columns of (1000 - 3*3)/4 = 247.75, at 3:2, plus the gap.
    expect(gridRowHeight(1000, 4)).toBeCloseTo(247.75 / 1.5 + GRID_GAP);
  });
});

describe('bandRowHeight', () => {
  test('a band fits its padding and its rows inside the height the row model gave it', () => {
    const rowHeight = 200;
    for (const rows of [1, 2, 7]) {
      const cell = bandRowHeight(rows, rowHeight);
      // What the band actually occupies: its cells, the gaps between them, and
      // the padding inside its outline. Anything over is the last row of members
      // hanging through the bottom of the band and over the grid below it.
      expect(rows * cell + (rows - 1) * GRID_GAP + 2 * BAND_PAD).toBeCloseTo(rows * rowHeight, 6);
    }
  });

  test('stays positive when the band is given less height than its padding', () => {
    expect(bandRowHeight(1, 4)).toBeGreaterThan(0);
    expect(bandRowHeight(0, 200)).toBe(0);
  });
});

describe('blockTops', () => {
  test('measures what it can and estimates the rest', () => {
    const tops = blockTops(3, new Map([[1, 500]]), 200);
    expect(tops).toEqual([0, 200 + GRID_GAP, 200 + 500 + 2 * GRID_GAP, 200 + 500 + 200 + 3 * GRID_GAP]);
  });

  test('is empty for an empty collection', () => {
    expect(blockTops(0, new Map(), 200)).toEqual([0]);
  });
});

describe('visibleBlocks', () => {
  const tops = blockTops(10, new Map(), 200); // blocks 203 apart

  test('spans the blocks the viewport touches', () => {
    // 500 lands inside block 2 (406..609); 500+400 reaches into block 4.
    expect(visibleBlocks(tops, 500, 400)).toEqual({ from: 2, to: 5 });
  });

  test('always offers at least the block under the scroll', () => {
    expect(visibleBlocks(tops, 0, 0)).toEqual({ from: 0, to: 1 });
  });
});

// A browser silently clamps a scroll past ~33.5M px (half that in Firefox), and
// the grid at its highest zoom - one column of thousand-pixel rows - reaches
// that at thirty thousand photos. Past the clamp the rest of the collection is
// simply unreachable, which is the one failure the virtual scroll exists to
// avoid, so the numbers that decide when scaling kicks in are worth pinning.
describe('MAX_SCROLL', () => {
  test('leaves room under the tightest browser limit', () => {
    const FIREFOX = 17_895_697;
    expect(MAX_SCROLL).toBeLessThan(FIREFOX);
  });

  test('the zoom that used to truncate a library is inside it', () => {
    // One column at the 1600px maximum tile: a 3:2 cell plus its gap.
    const pitch = gridRowHeight(1600, 1);
    expect(Math.floor(MAX_SCROLL / pitch)).toBeGreaterThan(13_000);
    // Unscaled this wanted 33.4M px for 31,370 rows, which is where Chromium cut
    // the collection off. Scaling is what keeps the tail reachable instead.
    expect(31_370 * pitch).toBeGreaterThan(MAX_SCROLL);
  });
});

test('a block is a whole number of photos, so an index maps to one block', () => {
  expect(Math.floor((BLOCK - 1) / BLOCK)).toBe(0);
  expect(Math.floor(BLOCK / BLOCK)).toBe(1);
});

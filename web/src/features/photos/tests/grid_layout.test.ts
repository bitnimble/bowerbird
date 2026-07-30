import { describe, expect, test } from 'bun:test';
import {
  BAND_PAD,
  BLOCK,
  GRID_GAP,
  RAIL_HEIGHT,
  anchorLimit,
  atRailWall,
  bandRowHeight,
  blockTops,
  gridColumns,
  gridRowHeight,
  masonryLineStarts,
  railHeight,
  recentred,
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

  // The whole point of the budget: a member is the same size as any other row of
  // the collection, so the same frame is not drawn at two shapes (§19.6).
  test('is the grid\'s own cell height, whatever the band holds', () => {
    for (const rows of [1, 2, 7]) expect(bandRowHeight(rows, 200)).toBe(200 - GRID_GAP);
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

// The rail is what replaced scaling a scroller into a browser's scroll ceiling.
// Everything here is about the two invariants that make it safe: the reader can
// still reach the end of the collection, and recentring the rail never moves what
// they are looking at.
describe('the rail', () => {
  const V = 800;
  const HUGE = 40_000_000; // a hundred thousand photos, one column, at maximum zoom

  test('is an element height every browser will honour', () => {
    // The whole point of the rail: the height handed to the browser no longer
    // describes the collection, so it never approaches a clamp. Firefox's is the
    // tightest at ~17.9M, Chromium's is 33,554,428.
    expect(RAIL_HEIGHT).toBeLessThan(17_895_697);
    expect(railHeight(HUGE)).toBeLessThan(17_895_697);
  });

  test('is the collection itself while the collection fits in it', () => {
    expect(railHeight(50_000)).toBe(50_000);
    expect(anchorLimit(50_000)).toBe(0);
  });

  test('caps at RAIL_HEIGHT, and the anchor covers the rest', () => {
    expect(railHeight(HUGE)).toBe(RAIL_HEIGHT);
    expect(anchorLimit(HUGE)).toBe(HUGE - RAIL_HEIGHT);
  });

  // The reachability of the tail is asserted against the presenter in
  // rail_scroll.test.ts, where it is a property of the wall logic rather than the
  // algebraic identity it is here.

  test('a collection the rail covers has no walls to be pushed off', () => {
    // Its ends are the collection's ends, and the reader is meant to reach them:
    // recentring there would refuse to let them scroll to the last row.
    expect(atRailWall(0, 50_000, V)).toBe(false);
    expect(atRailWall(50_000 - V, 50_000, V)).toBe(false);
  });

  test('a wall is only near an end of the rail', () => {
    expect(atRailWall(RAIL_HEIGHT / 2, HUGE, V)).toBe(false);
    // The margin is two viewports, so one viewport in is already inside it.
    expect(atRailWall(V * 2, HUGE, V)).toBe(false);
    expect(atRailWall(V * 2 - 1, HUGE, V)).toBe(true);
    expect(atRailWall(RAIL_HEIGHT - V - V * 2 + 1, HUGE, V)).toBe(true);
  });

  test('recentring leaves the reader exactly where they were', () => {
    const anchor = 5_000_000;
    const rail = 200; // right up against the top wall
    const put = recentred(anchor, rail, HUGE, V);
    expect(put.anchorTop + put.railTop).toBe(anchor + rail);
    expect(put.railTop).toBeCloseTo((RAIL_HEIGHT - V) / 2, 6);
  });

  test('near the top the anchor runs out first, and the position still holds', () => {
    // The rail cannot be centred without an anchor above zero to take it, so it
    // is left off-centre rather than the reader being moved to suit it.
    const put = recentred(0, 300, HUGE, V);
    expect(put.anchorTop).toBe(0);
    expect(put.railTop).toBe(300);
  });

  test('near the bottom the anchor stops at its limit, position intact', () => {
    const limit = anchorLimit(HUGE);
    const rail = RAIL_HEIGHT - V - 100;
    const put = recentred(limit, rail, HUGE, V);
    expect(put.anchorTop).toBe(limit);
    expect(put.anchorTop + put.railTop).toBe(limit + rail);
  });

  test('recentring from a wall puts the next wall a long way off', () => {
    // What buys the smooth scroll: writing scrollTop cancels a fling on macOS, so
    // the walls have to be far enough apart that a fling rarely reaches one.
    const put = recentred(5_000_000, V, HUGE, V);
    const toWall = RAIL_HEIGHT - V - V * 2 - put.railTop;
    expect(toWall).toBeGreaterThan(RAIL_HEIGHT / 3);
  });
});

describe('masonryLineStarts', () => {
  // 240px tiles at 3:2 are 360 wide, and a portrait 2:3 is 158.4; four of the
  // landscape and their gaps want 1449, three of them and the portrait 1247.4.
  const RATIOS = [1.5, 1.5, 2 / 3, 1.5, 1.5, 1.5];

  test('a line takes tiles until the next one no longer fits', () => {
    expect([...masonryLineStarts(RATIOS, 1200, 240)]).toEqual([0, 3]);
    // Room for the portrait as well, so the break moves along by one.
    expect([...masonryLineStarts(RATIOS, 1250, 240)]).toEqual([0, 4]);
  });

  test('a tile too wide for the line still gets a line, rather than none', () => {
    expect([...masonryLineStarts([1.5, 8, 1.5], 400, 240)]).toEqual([0, 1, 2]);
  });

  test('no width yet is one tile per line rather than a divide by zero', () => {
    expect([...masonryLineStarts([1.5, 1.5], 0, 240)]).toEqual([0, 1]);
  });
});

test('a block is a whole number of photos, so an index maps to one block', () => {
  expect(Math.floor((BLOCK - 1) / BLOCK)).toBe(0);
  expect(Math.floor(BLOCK / BLOCK)).toBe(1);
});

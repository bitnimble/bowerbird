import { describe, expect, test } from 'bun:test';
import { BLOCK, GRID_GAP, OVERSCAN_ROWS, blockTops, gridColumns, gridRowHeight, visibleBlocks, visibleRows } from '../grid_layout';

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

describe('visibleRows', () => {
  test('covers the viewport with overscan either side', () => {
    // Rows are 100 tall; the viewport shows rows 5 through 9.
    expect(visibleRows(500, 500, 100, 1000)).toEqual({ from: 5 - OVERSCAN_ROWS, to: 10 + OVERSCAN_ROWS });
  });

  test('clamps to the collection at both ends', () => {
    expect(visibleRows(0, 500, 100, 1000).from).toBe(0);
    expect(visibleRows(99_500, 500, 100, 1000).to).toBe(1000);
  });

  test('renders nothing when there is nothing to render', () => {
    expect(visibleRows(0, 500, 100, 0)).toEqual({ from: 0, to: 0 });
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

test('a block is a whole number of photos, so an index maps to one block', () => {
  expect(Math.floor((BLOCK - 1) / BLOCK)).toBe(0);
  expect(Math.floor(BLOCK / BLOCK)).toBe(1);
});

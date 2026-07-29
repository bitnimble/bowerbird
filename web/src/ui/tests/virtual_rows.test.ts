import { describe, expect, test } from 'bun:test';
import { OVERSCAN_ROWS, visibleRows } from '../virtual_rows';

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

  // A scroll position sampled a frame behind a collection that just shrank.
  // Read unclamped this gave from > to, which renders nothing at all.
  test('still renders a row when the scroll is past the end', () => {
    const span = visibleRows(1_000_000, 500, 100, 10);
    expect(span.from).toBeLessThan(span.to);
    expect(span.to).toBeLessThanOrEqual(10);
  });
});

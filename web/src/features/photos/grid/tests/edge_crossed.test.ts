import { describe, expect, test } from 'bun:test';
import { edgeCrossed } from '../grid_keys';

describe('edgeCrossed', () => {
  test('leaves left from the first column of any row', () => {
    expect(edgeCrossed('ArrowLeft', 0, 4)).toBe('left');
    expect(edgeCrossed('ArrowLeft', 8, 4)).toBe('left');
    expect(edgeCrossed('ArrowLeft', 9, 4)).toBeNull();
  });

  test('leaves up from the first row only', () => {
    expect(edgeCrossed('ArrowUp', 3, 4)).toBe('up');
    expect(edgeCrossed('ArrowUp', 4, 4)).toBeNull();
  });

  test('stays in the grid going right or down, and before there is a cursor', () => {
    expect(edgeCrossed('ArrowRight', 3, 4)).toBeNull();
    expect(edgeCrossed('ArrowDown', 0, 4)).toBeNull();
    expect(edgeCrossed('ArrowLeft', -1, 4)).toBeNull();
  });
});

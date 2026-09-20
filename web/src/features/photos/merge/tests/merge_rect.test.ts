import { expect, test } from 'bun:test';
import { seedAround } from '../merge_rect';

test('a seed is a square around the click, sized by the long edge', () => {
  expect(seedAround({ x: 500, y: 300 }, [2000, 1000])).toEqual({ x0: 490, y0: 290, x1: 510, y1: 310 });
});

test('a seed at the edge stops at the canvas', () => {
  expect(seedAround({ x: 2, y: 999 }, [2000, 1000])).toEqual({ x0: 0, y0: 989, x1: 12, y1: 1000 });
});

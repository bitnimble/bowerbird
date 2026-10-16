import { describe, expect, test } from 'bun:test';
import { nearest, type Box } from '../remote_navigation';

const box = (left: number, top: number, width = 40, height = 20): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('nearest', () => {
  const from = box(100, 100);

  test('takes the control in line over a closer one off to the side', () => {
    expect(nearest(from, [box(150, 160), box(220, 100)], 'right')).toBe(1);
  });

  test('takes the closer of two in line', () => {
    expect(nearest(from, [box(300, 100), box(160, 100)], 'right')).toBe(1);
  });

  test('ignores everything behind or beside the way the arrow points', () => {
    expect(nearest(from, [box(20, 100), box(100, 60), box(130, 100)], 'right')).toBeNull();
  });

  test('reaches a tall region beside a short control', () => {
    expect(nearest(from, [box(150, 0, 400, 500), box(150, 40)], 'right')).toBe(0);
  });

  test('moves down to the row below, then up back to it', () => {
    const below = box(100, 140);
    expect(nearest(from, [box(300, 140), below], 'down')).toBe(1);
    expect(nearest(below, [box(300, 100), from], 'up')).toBe(1);
  });

  test('counts edges touching across a border as beside', () => {
    expect(nearest(from, [box(139, 100)], 'right')).toBe(0);
  });
});

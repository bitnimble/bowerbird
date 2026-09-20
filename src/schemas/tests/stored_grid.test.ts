import { describe, expect, test } from 'bun:test';
import { EditDocSchema, RepairSchema } from '../photo_edits';
import { MOST_REPAIR_VERTICES, STORED_LONG, storedLoop, storedSize } from '../stored_grid';

describe('the grid a repair is written on', () => {
  // `px::Size::stored`'s own answers, which `a_stored_position_is_the_same_place_and_the_grid_is_square`
  // pins on that side.
  test('spans the long edge whichever way the photograph stands', () => {
    expect(storedSize(6000, 4000)).toEqual({ width: STORED_LONG, height: 43690 });
    expect(storedSize(4000, 6000)).toEqual({ width: 43690, height: STORED_LONG });
  });

  test('takes a lasso of hundreds of points down to what the document holds', () => {
    const drawn = Array.from({ length: 900 }, (_, at) => {
      const angle = (at / 900) * Math.PI * 2;
      return { x: 0.5 + 0.2 * Math.cos(angle), y: 0.5 + 0.2 * Math.sin(angle) };
    });
    const loop = storedLoop(drawn, { width: 6000, height: 4000 });
    expect(loop).not.toBeNull();
    expect(loop!.length).toBeLessThanOrEqual(MOST_REPAIR_VERTICES);
    expect(loop!.length).toBeGreaterThan(8);
    // Still the loop it was drawn as: every vertex a fifth of each edge from the centre.
    for (const [x, y] of loop!) {
      expect(Math.hypot((x / STORED_LONG - 0.5) / 0.2, (y / 43690 - 0.5) / 0.2)).toBeCloseTo(1, 2);
    }
    // And what the document accepts.
    const repair = { drawn: loop, seam: loop, donor: [100, -100], gain: 1 };
    expect(RepairSchema.safeParse(repair).success).toBe(true);
  });

  test('refuses a loop that encloses nothing', () => {
    expect(storedLoop([{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }], { width: 6000, height: 4000 })).toBeNull();
    const line = [0.1, 0.2, 0.3].map((x) => ({ x, y: 0.5 }));
    expect(storedLoop(line, { width: 6000, height: 4000 })).toBeNull();
  });

  test('is bounded in the document, which is one replicated cell', () => {
    const loop: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const repair = { drawn: loop, seam: loop, donor: [0, 0], gain: 1 };
    expect(EditDocSchema.safeParse({ repairs: Array.from({ length: 64 }, () => repair) }).success).toBe(true);
    expect(EditDocSchema.safeParse({ repairs: Array.from({ length: 65 }, () => repair) }).success).toBe(false);
    expect(RepairSchema.safeParse({ ...repair, gain: 20 }).success).toBe(false);
    expect(RepairSchema.safeParse({ ...repair, seam: [[0, 0], [STORED_LONG + 1, 0], [0, 1]] }).success).toBe(false);
    expect(EditDocSchema.parse({}).repairs).toEqual([]);
  });
});

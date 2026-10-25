import { describe, expect, test } from 'bun:test';
import { EditDocSchema, pastableEdits, ReflectionStrokeSchema, RepairSchema } from '../photo_edits';
import {
  MOST_REPAIR_VERTICES,
  MOST_STROKE_POINTS,
  STORED_LONG,
  storedLoop,
  storedPolyline,
  storedSize,
} from '../stored_grid';

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
    expect(
      storedLoop(
        [
          { x: 0.1, y: 0.1 },
          { x: 0.1, y: 0.1 },
        ],
        { width: 6000, height: 4000 },
      ),
    ).toBeNull();
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
    expect(
      EditDocSchema.safeParse({ repairs: Array.from({ length: 64 }, () => repair) }).success,
    ).toBe(true);
    expect(
      EditDocSchema.safeParse({ repairs: Array.from({ length: 65 }, () => repair) }).success,
    ).toBe(false);
    expect(RepairSchema.safeParse({ ...repair, gain: 20 }).success).toBe(false);
    expect(
      RepairSchema.safeParse({
        ...repair,
        seam: [
          [0, 0],
          [STORED_LONG + 1, 0],
          [0, 1],
        ],
      }).success,
    ).toBe(false);
    expect(EditDocSchema.parse({}).repairs).toEqual([]);
  });
});

describe('a reflection stroke on the grid', () => {
  const FRAME = { width: 6000, height: 4000 };

  test('keeps a tap as the one point it is', () => {
    expect(storedPolyline([{ x: 0.5, y: 0.5 }], FRAME)).toEqual([[32768, 21845]]);
    expect(storedPolyline([], FRAME)).toBeNull();
  });

  test('stays open, and drops what lies within the tolerance of the line', () => {
    const drawn = [
      { x: 0.1, y: 0.5 },
      { x: 0.2, y: 0.5001 },
      { x: 0.3, y: 0.5 },
      { x: 0.3, y: 0.6 },
    ];
    expect(storedPolyline(drawn, FRAME, 10)).toEqual([
      [6554, 21845],
      [19661, 21845],
      [19661, 26214],
    ]);
  });

  test('takes a scribble of thousands of points down to what the document holds', () => {
    const drawn = Array.from({ length: 4000 }, (_, at) => ({
      x: at / 4000,
      y: 0.5 + 0.3 * Math.sin(at / 7),
    }));
    const line = storedPolyline(drawn, FRAME);
    expect(line!.length).toBeLessThanOrEqual(MOST_STROKE_POINTS);
    expect(line![0]).toEqual([0, Math.round(0.5 * 43690)]);
    expect(
      ReflectionStrokeSchema.safeParse({ kind: 'remove', radius: 100, points: line }).success,
    ).toBe(true);
  });

  test('is bounded in the document, and off with no strokes until the reader asks', () => {
    const doc = EditDocSchema.parse({});
    expect(doc.reflectionRemoval).toBe(false);
    expect(doc.reflectionStrength).toBe(100);
    expect(doc.reflectionStrokes).toEqual([]);

    const stroke = { kind: 'keep', radius: 3000, points: [[10, 20]] };
    const strokes = (count: number): unknown[] => Array.from({ length: count }, () => stroke);
    expect(EditDocSchema.safeParse({ reflectionStrokes: strokes(64) }).success).toBe(true);
    expect(EditDocSchema.safeParse({ reflectionStrokes: strokes(65) }).success).toBe(false);
    expect(EditDocSchema.safeParse({ reflectionStrength: 201 }).success).toBe(false);
    expect(EditDocSchema.safeParse({ reflectionStrength: 50.5 }).success).toBe(false);
    for (const wrong of [
      { ...stroke, kind: 'erase' },
      { ...stroke, radius: 0 },
      { ...stroke, radius: STORED_LONG + 1 },
      { ...stroke, points: [] },
      { ...stroke, points: Array.from({ length: 257 }, () => [1, 1]) },
      { ...stroke, points: [[-1, 5]] },
      { ...stroke, points: [[5, STORED_LONG + 1]] },
    ]) {
      expect(ReflectionStrokeSchema.safeParse(wrong).success).toBe(false);
    }
  });

  test("is pasted as a switch and a strength, never as the strokes, which are this frame's", () => {
    const doc = EditDocSchema.parse({
      reflectionRemoval: true,
      reflectionStrength: 150,
      reflectionStrokes: [{ kind: 'remove', radius: 3000, points: [[10, 20]] }],
    });
    const pasted = pastableEdits(doc);
    expect(pasted.reflectionRemoval).toBe(true);
    expect(pasted.reflectionStrength).toBe(150);
    expect('reflectionStrokes' in pasted).toBe(false);
  });
});

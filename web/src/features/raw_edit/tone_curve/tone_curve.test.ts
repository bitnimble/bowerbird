import { expect, test } from 'bun:test';
import { ToneCurvePointsSchema, type ToneCurvePoints } from '../../../../../src/schemas/photo_edits';
import { evaluate, IDENTITY_CURVE, insertPoint, movePoint, nudgePoint, removePoint, tangents } from './tone_curve';

test('matches native tone curve tangents and samples', async () => {
  const fixtures = await Bun.file(new URL('../../../../../test/fixtures/tables/tone-curve.json', import.meta.url).pathname).json() as {
    name: string;
    points: ToneCurvePoints;
    tangents: number[];
    samples: [number, number][];
  }[];
  expect(fixtures.length).toBeGreaterThan(0);
  for (const fixture of fixtures) {
    const actual = tangents(fixture.points);
    expect(actual).toHaveLength(fixture.tangents.length);
    for (const [index, expected] of fixture.tangents.entries()) {
      expect(Math.abs(actual[index]! - expected), `${fixture.name} tangent ${index}`).toBeLessThanOrEqual(1e-9);
    }
    expect(fixture.samples.some(([x]) => x === -0.1), fixture.name).toBe(true);
    expect(fixture.samples.some(([x]) => x === 1.1), fixture.name).toBe(true);
    for (const [x, expected] of fixture.samples) {
      expect(Math.abs(evaluate(fixture.points, x) - expected), `${fixture.name} at ${x}`).toBeLessThanOrEqual(1e-9);
    }
  }
});

test('identity curve stays linear, including diffuse white', () => {
  expect(tangents(IDENTITY_CURVE)).toEqual([1, 1]);
  expect(evaluate(IDENTITY_CURVE, 0.25)).toBe(0.25);
  expect(evaluate(IDENTITY_CURVE, 0.5)).toBe(0.5);
  expect(evaluate(IDENTITY_CURVE, 1)).toBe(1);
});

test('inserting across a flat segment always stays within its neighbours', () => {
  for (let index = 1; index < 1000; index += 1) {
    const inserted = insertPoint([[0.2, 0.6], [0.8, 0.6]], 0.2 + 0.6 * index / 1000);
    if (inserted != null) {
      expect(ToneCurvePointsSchema.parse(inserted.points)[1]).toEqual([0.2 + 0.6 * index / 1000, 0.6]);
    }
  }
});

test('monotone points stay monotone, with flat toe and linear head', () => {
  const points: ToneCurvePoints = [[0.1, 0.2], [0.35, 0.25], [0.8, 0.7]];
  let previous = evaluate(points, 0);
  for (let index = 1; index <= 100; index += 1) {
    const next = evaluate(points, index / 100);
    expect(next).toBeGreaterThanOrEqual(previous);
    previous = next;
  }
  expect(evaluate(points, 0)).toBe(0.2);
  expect(evaluate(points, 1)).toBeCloseTo(0.9);
});

test('insertion, dragging, removal and bounds preserve valid points', () => {
  const inserted = insertPoint(IDENTITY_CURVE, 0.5)!;
  expect(inserted).toEqual({ index: 1, points: [[0, 0], [0.5, 0.5], [1, 1]] });
  expect(insertPoint(inserted.points, 0.5)).toBeNull();
  expect(insertPoint([[0.2, 0], [0.8, 1]], 0.1)).toEqual({ index: 0, points: [[0.1, 0], [0.2, 0], [0.8, 1]] });
  expect(insertPoint([[0.2, 0], [0.8, 1]], 0.9)).toEqual({ index: 2, points: [[0.2, 0], [0.8, 1], [0.9, 1]] });
  expect(movePoint(inserted.points, 1, 2, -1)[1]).toEqual([1 - 1 / 1024, 0]);
  expect(movePoint(inserted.points, 0, 0.2, 0.01)[0]).toEqual([0.2, 0]);
  expect(movePoint(inserted.points, 0, 0.01, 0.2)[0]).toEqual([0, 0.2]);
  expect(movePoint(inserted.points, 2, 0.7, 0.99)[2]).toEqual([0.7, 1]);
  expect(movePoint(inserted.points, 2, 0.99, 0.7)[2]).toEqual([1, 0.7]);
  const monotone: ToneCurvePoints = [[0, 0.2], [0.5, 0.5], [1, 0.8]];
  expect(movePoint(monotone, 1, 0.5, -1)[1]).toEqual([0.5, 0.2]);
  expect(movePoint(monotone, 1, 0.5, 2)[1]).toEqual([0.5, 0.8]);
  expect(movePoint(monotone, 0, 0, 0.9)[0]).toEqual([0, 0.5]);
  expect(movePoint(monotone, 2, 1, 0.1)[2]).toEqual([1, 0.5]);
  expect(nudgePoint(inserted.points, 1, 'ArrowUp', 0.01)[1]).toEqual([0.5, 0.51]);
  expect(nudgePoint([[0, 0.2], [1, 1]], 0, 'ArrowRight', 0.01)).toEqual([[0, 0.2], [1, 1]]);
  expect(removePoint(inserted.points, 1)).toEqual(IDENTITY_CURVE);
  expect(removePoint(inserted.points, 0)).toBe(inserted.points);
  expect(removePoint(inserted.points, 2)).toBe(inserted.points);
  const full: ToneCurvePoints = Array.from({ length: 16 }, (_, index) => [index / 15, index / 15]);
  expect(insertPoint(full, 0.5)).toBeNull();
});

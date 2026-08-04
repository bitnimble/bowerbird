// The two pure decisions the open makes before a single dispatch is recorded.
import { afterEach, describe, expect, test } from 'bun:test';
import { SUPERSAMPLE, stageResolution, tickFeatures } from '../tick_pipeline';

const global = globalThis as { devicePixelRatio?: number };
const real = global.devicePixelRatio;
afterEach(() => {
  global.devicePixelRatio = real;
});

const WHOLE = { x: 0, y: 0, width: 6000, height: 4000 };
const MAX = 16384;

describe('stageResolution', () => {
  test('fits the region into the box and keeps its aspect', () => {
    global.devicePixelRatio = 1;
    const size = stageResolution({ width: 900, height: 900 }, WHOLE, MAX);
    // Contained, not stretched: the element is `object-fit: contain`, so a backing store of
    // another shape is a stretched photograph.
    expect(size.width / size.height).toBeCloseTo(WHOLE.width / WHOLE.height, 2);
    expect(size.width).toBe(Math.round(900 * SUPERSAMPLE));
  });

  // The half of the calculation the resize observer cannot see. A density change moves this
  // without moving the CSS box, which is why the presenter watches it separately.
  test('scales with devicePixelRatio', () => {
    global.devicePixelRatio = 1;
    const one = stageResolution({ width: 900, height: 900 }, WHOLE, MAX);
    global.devicePixelRatio = 2;
    const two = stageResolution({ width: 900, height: 900 }, WHOLE, MAX);
    expect(two.width).toBe(one.width * 2);
  });

  test('never asks for more than the region has', () => {
    global.devicePixelRatio = 3;
    const region = { x: 0, y: 0, width: 40, height: 30 };
    const size = stageResolution({ width: 4000, height: 4000 }, region, MAX);
    expect(size.width).toBeLessThanOrEqual(region.width);
    expect(size.height).toBeLessThanOrEqual(region.height);
  });

  test('never asks for more than the GPU can hold', () => {
    global.devicePixelRatio = 4;
    const size = stageResolution({ width: 20000, height: 20000 }, WHOLE, 8192);
    expect(size.width).toBeLessThanOrEqual(8192);
    expect(size.height).toBeLessThanOrEqual(8192);
  });

  // A zero box arrives before layout, and a canvas of zero is a validation error rather than
  // an empty picture.
  test.each([
    [0, 0],
    [900, 0],
    [0, 900],
  ])('stays at least one pixel for a %ix%i box', (width, height) => {
    global.devicePixelRatio = 1;
    const size = stageResolution({ width, height }, WHOLE, MAX);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe('tickFeatures', () => {
  const adapter = (features: string[]): GPUAdapter =>
    ({ features: new Set(features) }) as unknown as GPUAdapter;

  // Filtered rather than required, this left the device built without it and the failure to
  // a validation error the open cannot catch - so the reader was told `live` over a black
  // canvas, with nothing anywhere saying why.
  test('refuses an adapter that cannot filter float textures', () => {
    expect(() => tickFeatures(adapter(['timestamp-query']))).toThrow(/float32-filterable/);
  });

  test('asks for the timer only where it exists', () => {
    expect(tickFeatures(adapter(['float32-filterable']))).toEqual(['float32-filterable']);
    expect(tickFeatures(adapter(['float32-filterable', 'timestamp-query']))).toEqual([
      'float32-filterable',
      'timestamp-query',
    ]);
  });
});

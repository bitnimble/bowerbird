// The two pure decisions the open makes before a single dispatch is recorded.
import { afterEach, describe, expect, test } from 'bun:test';
import { SUPERSAMPLE, frameTooBig, stageResolution, tickFeatures } from '../tick_pipeline';

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

  // A region wider than the limit, which is the only case that reaches the limit at all: the
  // clamp against the region's own resolution binds first for anything smaller. Written with
  // `WHOLE` at 6000px it asserted `6000 <= 8192` and held for any limit, including none -
  // deleting the limit from the `Math.min` left it green.
  //
  // 9504 is a 61MP body's long edge and 8192 is what several adapters report, so this is the
  // pair the branch was built for.
  test('never asks for more than the GPU can hold', () => {
    global.devicePixelRatio = 4;
    const sensor = { x: 0, y: 0, width: 9504, height: 6336 };
    expect(stageResolution({ width: 20000, height: 20000 }, sensor, 8192).width).toBe(8192);
    // And the limit is what did it, rather than something else that happens to land there.
    expect(stageResolution({ width: 20000, height: 20000 }, sensor, 16384).width).toBe(9504);
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

describe('frameTooBig', () => {
  // A 61MP sensor against the cap most phones report. The frame is a buffer and the biggest
  // texture cut from it is the pyramid's base at half a side, so 9504 needs 4752 - and
  // measuring the cap against 9504 refused the frame for a texture nothing creates. The
  // Android build is where this bites: it cannot ask for more than its GPU offers.
  test('lets a frame open when the pyramid it needs fits', () => {
    expect(frameTooBig(9504, 6336, 8192)).toBeNull();
  });

  test('refuses one whose pyramid does not, and says the size that would', () => {
    expect(frameTooBig(9504, 6336, 4096)).toContain('8192px');
    expect(frameTooBig(9504, 6336, 4096)).toContain('9504x6336');
  });

  // The boundary itself, both sides of it, since the halving is where an off-by-one would go.
  test('holds at the exact edge', () => {
    expect(frameTooBig(16384, 100, 8192)).toBeNull();
    expect(frameTooBig(16386, 100, 8192)).not.toBeNull();
  });
});

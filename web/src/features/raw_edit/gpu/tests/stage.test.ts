// The two pure decisions the open makes before a single dispatch is recorded.
import { afterEach, describe, expect, test } from 'bun:test';
import { SUPERSAMPLE, frameTooBig, stageResolution, editFeatures } from '../edit_pipeline';

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

  // Held at the region's own resolution instead, a magnified draw hands the compositor a canvas
  // a fraction of the box and lets its filter do the enlarging, which smooths away the per-pixel
  // variation that was dithering the display's quantisation - a banded sky at every zoom past
  // 1:1, and none below it.
  test('magnifies at the display resolution rather than the region resolution', () => {
    global.devicePixelRatio = 3;
    const region = { x: 0, y: 0, width: 40, height: 30 };
    const size = stageResolution({ width: 400, height: 400 }, region, MAX);
    expect(size.width).toBe(400 * 3);
    expect(size.height).toBe(300 * 3);
  });

  // And no further: above 1:1 the frame has no detail left to resolve, so the supersample that
  // antialiases a minified draw would be fragments spent on nothing.
  test('does not supersample a magnified region', () => {
    global.devicePixelRatio = 1;
    const region = { x: 0, y: 0, width: 100, height: 100 };
    expect(stageResolution({ width: 400, height: 400 }, region, MAX).width).toBe(400);
  });

  // A region wider than the limit, shown whole on a display that can nearly hold it: the box is
  // what binds for anything smaller. Written with `WHOLE` at 6000px it asserted `6000 <= 8192`
  // and held for any limit, including none - deleting the limit from the `Math.min` left it
  // green.
  //
  // 9504 is a 61MP body's long edge and 8192 is what several adapters report, so this is the
  // pair the branch was built for.
  test('never asks for more than the GPU can hold', () => {
    global.devicePixelRatio = 4;
    const sensor = { x: 0, y: 0, width: 9504, height: 6336 };
    expect(stageResolution({ width: 2376, height: 1584 }, sensor, 8192).width).toBe(8192);
    // And the limit is what did it, rather than something else that happens to land there.
    expect(stageResolution({ width: 2376, height: 1584 }, sensor, 16384).width).toBe(9504);
  });

  // The limit binds on the long edge and nothing binds on the short one, which is where a
  // per-axis clamp let the two come apart: 8192x6336 for a 3:2 frame is a picture stretched
  // sixteen percent tall, on every adapter that reports 8192 and every 61MP file.
  test('keeps the aspect when only one edge reaches the limit', () => {
    global.devicePixelRatio = 4;
    const sensor = { x: 0, y: 0, width: 9504, height: 6336 };
    const size = stageResolution({ width: 2376, height: 1584 }, sensor, 8192);
    expect(size.width / size.height).toBeCloseTo(sensor.width / sensor.height, 2);
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

describe('editFeatures', () => {
  const adapter = (features: string[]): GPUAdapter =>
    ({ features: new Set(features) }) as unknown as GPUAdapter;

  // The chroma map is `rgba16float` so that this need not be asked for. Required, it refused
  // every iPhone at the open - no Apple GPU filters 32-bit float - and asking for it where it
  // happens to exist would leave the two platforms reading a differently-quantised map.
  test('never asks for float32-filterable, even where it exists', () => {
    expect(editFeatures(adapter(['float32-filterable']))).toEqual([]);
  });

  test('asks for the timer only where it exists', () => {
    expect(editFeatures(adapter([]))).toEqual([]);
    expect(editFeatures(adapter(['float32-filterable', 'timestamp-query']))).toEqual([
      'timestamp-query',
    ]);
  });
});

describe('frameTooBig', () => {
  // What an adapter that raised its limits offers. `editLimits` asks for the adapter's own
  // maximum, and a desktop one answers in gigabytes.
  const ROOMY = {
    maxTextureDimension2D: 8192,
    maxBufferSize: 4 * 1024 ** 3,
    maxStorageBufferBindingSize: 4 * 1024 ** 3,
  };

  // A 61MP sensor against the side cap most phones report. The frame is a buffer and the
  // biggest texture cut from it is the pyramid's base at half a side, so 9504 needs 4752 -
  // and measuring that cap against 9504 refused the frame for a texture nothing creates. The
  // Android build is where this bites: it cannot ask for more than its GPU offers.
  test('lets a frame open when the pyramid it needs fits', () => {
    expect(frameTooBig(9504, 6336, ROOMY)).toBeNull();
  });

  test('refuses one whose pyramid does not, and says the size that would', () => {
    const tight = { ...ROOMY, maxTextureDimension2D: 4096 };
    expect(frameTooBig(9504, 6336, tight)).toContain('8192px');
    expect(frameTooBig(9504, 6336, tight)).toContain('9504x6336');
  });

  // The boundary itself, both sides of it, since the halving is where an off-by-one would go.
  test('holds at the exact edge', () => {
    expect(frameTooBig(16384, 100, ROOMY)).toBeNull();
    expect(frameTooBig(16386, 100, ROOMY)).not.toBeNull();
  });

  // And the half the side used to stand in for. Loosening the side check let a frame past
  // that the adapter cannot hold, and `createBuffer` refusing it is a validation error rather
  // than an exception - so the open ran to the end and the reader was told `live` over a black
  // canvas. 61MP is 345MiB against WebGPU's 256MiB default; both are said in the units the
  // limits themselves are round numbers in, which is why this is not the 361MB the comments
  // elsewhere quote for the same frame in decimal.
  test('refuses a frame the adapter has no room for, in bytes', () => {
    const small = { ...ROOMY, maxBufferSize: 256 * 1024 ** 2 };
    expect(frameTooBig(9504, 6336, small)).toContain('256MB');
    expect(frameTooBig(9504, 6336, small)).toContain('345MB');
  });

  // Binding as well as allocation: the frame is bound as storage to every pass that reads it,
  // and the two limits are reported separately and are not always the same number.
  test('refuses one it could allocate but not bind', () => {
    const bindless = { ...ROOMY, maxStorageBufferBindingSize: 128 * 1024 ** 2 };
    expect(frameTooBig(9504, 6336, bindless)).toContain('128MB');
  });
});

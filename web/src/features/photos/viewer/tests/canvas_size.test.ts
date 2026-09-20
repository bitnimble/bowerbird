import { expect, test } from 'bun:test';
import { canvasSizeFor } from '../stage_bitmaps';

/**
 * A panorama is the frame that finds this: a decoder that ignores `desiredWidth` hands back the
 * whole 33804x9376 canvas, sizing the element to it gets a canvas the browser silently refuses,
 * and the frame then reads as one the server never had - the stage blank and "Dimensions" stuck
 * on loading, because the shape is only reported once the draw has landed.
 */
test('fits a frame no browser would allocate into one every browser will', () => {
  const box = canvasSizeFor(33804, 9376);

  expect(Math.max(box.width, box.height)).toBeLessThanOrEqual(8192);
  expect(box.width / box.height).toBeCloseTo(33804 / 9376, 2);
});

test('leaves a frame already inside the cap exactly as it is', () => {
  expect(canvasSizeFor(4096, 2731)).toEqual({ width: 4096, height: 2731 });
});

// A long thin region of a canvas sits well inside any area limit and past every edge limit, so
// the cap is per axis rather than on the product.
test('caps the long axis of a strip that costs few pixels', () => {
  expect(canvasSizeFor(33470, 500).width).toBe(8192);
});

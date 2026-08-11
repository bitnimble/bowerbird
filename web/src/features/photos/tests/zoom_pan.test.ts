// The pan maths, which both surfaces share: the viewer's `<img>` under a transform and the
// editor's canvas, which is told a region instead.
import { describe, expect, test } from 'bun:test';
import { DOUBLE_SCALE, MIN_SCALE, clampPan, fitScale, nextStopAfter, regionOf, zoomAbout, type View } from '../zoom_pan';

const NATURAL = { width: 6000, height: 4000 };
const BOX = { width: 1000, height: 800 };

describe('clampPan', () => {
  test('holds the photo against the viewport edge', () => {
    // Fitted, the frame is 1000x667 in a 1000x800 box; at 2x it is 2000 wide, so 500 of it
    // hangs off each side and the offset may reach half of that.
    const held = clampPan({ scale: 2, x: 9999, y: 0 }, BOX, NATURAL);
    expect(held.x).toBeCloseTo(500);
  });

  test('leaves an offset that is already inside alone', () => {
    const view: View = { scale: 2, x: 120, y: -30 };
    expect(clampPan(view, BOX, NATURAL)).toEqual(view);
  });

  // The observer's box before it has fired, which is what a pointermove now passes rather
  // than measuring the element itself. Read at face value it says nothing fits anywhere and
  // pulls the offset to zero, which would drop a zoomed photo back to the middle mid-drag.
  test('cannot clamp against a box of no extent, and does not try', () => {
    const view: View = { scale: 3, x: 240, y: 90 };
    expect(clampPan(view, { width: 0, height: 0 }, NATURAL)).toEqual(view);
    expect(clampPan(view, { width: 1000, height: 0 }, NATURAL)).toEqual(view);
    expect(clampPan(view, null, NATURAL)).toEqual(view);
  });

  test('nor against a frame whose size is not known yet', () => {
    const view: View = { scale: 3, x: 240, y: 90 };
    expect(clampPan(view, BOX, { width: 0, height: 0 })).toEqual(view);
  });
});

describe('regionOf', () => {
  test('is the whole frame when the view is fitted', () => {
    const region = regionOf({ scale: 1, x: 0, y: 0 }, BOX, NATURAL);
    expect(region).toEqual({ x: 0, y: 0, width: 6000, height: 4000 });
  });

  // Zoomed and panned right, the viewport sits further right over the picture - the opposite
  // direction to the offset, which moves the picture under the viewport.
  test('follows the pan the other way', () => {
    const centred = regionOf({ scale: 2, x: 0, y: 0 }, BOX, NATURAL);
    const panned = regionOf({ scale: 2, x: 100, y: 0 }, BOX, NATURAL);
    expect(panned.x).toBeLessThan(centred.x);
    expect(panned.width).toBeCloseTo(centred.width);
  });

  test('stays inside the frame however far the pan goes', () => {
    for (const x of [-99999, 99999]) {
      const region = regionOf({ scale: 4, x, y: x }, BOX, NATURAL);
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(NATURAL.width);
      expect(region.y + region.height).toBeLessThanOrEqual(NATURAL.height);
    }
  });
});

// The gesture as a whole, which was a Playwright click and drag over a real RAW: the region is
// the only thing either of those produces, and it is arithmetic all the way down.
describe('zooming about the point the reader asked for', () => {
  const box = { left: 0, top: 0, width: BOX.width, height: BOX.height } as DOMRect;

  test('leaves the region around that point rather than the middle', () => {
    // A quarter in from the top left, which is where the click landed.
    const view = clampPan(zoomAbout(FITTED_VIEW, 2, 8, box, { x: 250, y: 200 }), BOX, NATURAL);
    const region = regionOf(view, BOX, NATURAL);

    expect(region.width).toBeLessThan(NATURAL.width);
    expect(region.height).toBeLessThan(NATURAL.height);
    // Up and to the left of where a zoom about the centre would have left it.
    expect(region.x).toBeLessThan((NATURAL.width - region.width) / 2);
    expect(region.y).toBeLessThan((NATURAL.height - region.height) / 2);
    expect(region.x).toBeGreaterThanOrEqual(0);
    expect(region.y).toBeGreaterThanOrEqual(0);
  });

  test('a pan moves the window without resizing it', () => {
    const zoomed = clampPan(zoomAbout(FITTED_VIEW, 2, 8, box, { x: 250, y: 200 }), BOX, NATURAL);
    // The picture goes the other way to the pointer, so dragging left moves the window right.
    const panned = clampPan({ ...zoomed, x: zoomed.x - 120 }, BOX, NATURAL);

    const was = regionOf(zoomed, BOX, NATURAL);
    const now = regionOf(panned, BOX, NATURAL);
    expect(now.x).toBeGreaterThan(was.x);
    expect(now.width).toBeCloseTo(was.width);
    expect(now.height).toBeCloseTo(was.height);
    expect(now.x + now.width).toBeLessThanOrEqual(NATURAL.width + 1);
  });

  test('climbs the ladder and turns around at the top', () => {
    // Fitted, twice that, the frame's own pixels, and round to fitted again.
    const native = 1 / fitScale(BOX, NATURAL);
    expect(nextStopAfter(MIN_SCALE, native)).toBe(DOUBLE_SCALE);
    expect(nextStopAfter(DOUBLE_SCALE, native)).toBeCloseTo(native);
    expect(nextStopAfter(native, native)).toBe(MIN_SCALE);
  });

  test('takes 100% before twice-fitted where that is the nearer stop', () => {
    // A render only a little larger than the stage: fitted, it is already most of the way to
    // 1:1, so the 100% stop sits below twice-fitted and is reached first. This is what the
    // ladder is sorted for rather than listed in order.
    const nearly = { width: 1200, height: 900 };
    const native = 1 / fitScale(BOX, nearly);
    expect(native).toBeGreaterThan(MIN_SCALE);
    expect(native).toBeLessThan(DOUBLE_SCALE);
    expect(nextStopAfter(MIN_SCALE, native)).toBeCloseTo(native);
    expect(nextStopAfter(native, native)).toBe(DOUBLE_SCALE);
    expect(nextStopAfter(DOUBLE_SCALE, native)).toBe(MIN_SCALE);
  });

  test('has one stop where the frame is smaller than the stage', () => {
    // Below 1:1 when fitted, so 100% is not a stop the reader can climb *to*: it is behind
    // them. The ladder filters it rather than offering a zoom that shrinks the picture.
    const small = { width: 400, height: 300 };
    const native = 1 / fitScale(BOX, small);
    expect(native).toBeLessThan(MIN_SCALE);
    expect(nextStopAfter(MIN_SCALE, native)).toBe(DOUBLE_SCALE);
    expect(nextStopAfter(DOUBLE_SCALE, native)).toBe(MIN_SCALE);
  });
});

const FITTED_VIEW: View = { scale: 1, x: 0, y: 0 };

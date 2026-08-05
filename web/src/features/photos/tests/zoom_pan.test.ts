// The pan maths, which both surfaces share: the viewer's `<img>` under a transform and the
// editor's canvas, which is told a region instead.
import { describe, expect, test } from 'bun:test';
import { clampPan, regionOf, type View } from '../zoom_pan';

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

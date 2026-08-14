// The inset crop, against the two things it promises: no blank inside it, and not much left
// outside it.
//
// The first is the requirement and is checked by sampling - a rectangle is inside the picture
// exactly when its four corners are, the region being convex. The second is what stops a
// "correct" answer of nothing: a rectangle of one pixel satisfies the first claim perfectly.
import { describe, expect, test } from 'bun:test';
import { insetCrop, type Bounds } from '../crop_to_bounds';
import { keystoneFromGuides, keystoneShows, type Keystone } from '../keystone';
import type { CropRect } from '../crop_turn';

const FRAME = { width: 4000, height: 3000 };

/** The picture's corners in the straightened frame's fractions - what the crop is measured in. */
function quad(bounds: Bounds): { x: number; y: number }[] {
  const radians = (bounds.cropAngle * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const straight = {
    x: bounds.width * Math.abs(c) + bounds.height * Math.abs(s),
    y: bounds.width * Math.abs(s) + bounds.height * Math.abs(c),
  };
  return [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ].map((corner) => {
    const moved = bounds.keystone == null ? corner : keystoneShows(bounds.keystone, corner.x, corner.y)!;
    const fx = moved.x * bounds.width - bounds.width / 2;
    const fy = moved.y * bounds.height - bounds.height / 2;
    return {
      x: (fx * c - fy * s + straight.x / 2) / straight.x,
      y: (fx * s + fy * c + straight.y / 2) / straight.y,
    };
  });
}

/** Whether a point is inside the convex quad, to a hair's tolerance. */
function inside(shape: { x: number; y: number }[], point: { x: number; y: number }): boolean {
  let sign = 0;
  for (let i = 0; i < shape.length; i += 1) {
    const a = shape[i]!;
    const b = shape[(i + 1) % shape.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const now = Math.sign(cross);
    if (sign === 0) sign = now;
    else if (now !== sign) return false;
  }
  return true;
}

function corners(rect: CropRect): { x: number; y: number }[] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];
}

const area = (rect: CropRect): number => (rect.right - rect.left) * (rect.bottom - rect.top);

describe('the crop that fits inside a corrected picture', () => {
  test('asks for nothing from a frame with nothing to trim', () => {
    expect(insetCrop({ ...FRAME, cropAngle: 0, keystone: null })).toBeNull();
  });

  test('leaves no blank in the corner of a straightened frame', () => {
    const bounds: Bounds = { ...FRAME, cropAngle: 6, keystone: null };
    const rect = insetCrop(bounds)!;
    expect(rect).not.toBeNull();
    for (const corner of corners(rect)) {
      expect(inside(quad(bounds), corner), `${corner.x}, ${corner.y}`).toBe(true);
    }
  });

  test('keeps most of a straightened frame, rather than retreating to the middle', () => {
    // The closed form for the largest axis-aligned rectangle inside a rotated rectangle, as a
    // share of the *bounding box* the crop's fractions are of. A search that stopped early
    // would satisfy the "no blank" test and fail this one.
    const angle = 6;
    const radians = (angle * Math.PI) / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const [long, short] = FRAME.width >= FRAME.height ? [FRAME.width, FRAME.height] : [FRAME.height, FRAME.width];
    const inner =
      short <= 2 * s * c * long
        ? { w: (0.5 * short) / s, h: (0.5 * short) / c }
        : {
            w: (FRAME.width * c - FRAME.height * s) / (c * c - s * s),
            h: (FRAME.height * c - FRAME.width * s) / (c * c - s * s),
          };
    const box = {
      x: FRAME.width * Math.abs(c) + FRAME.height * Math.abs(s),
      y: FRAME.width * Math.abs(s) + FRAME.height * Math.abs(c),
    };
    const want = ((inner.w / box.x) * inner.h) / box.y;

    const rect = insetCrop({ ...FRAME, cropAngle: angle, keystone: null })!;
    expect(area(rect) / want).toBeGreaterThan(0.98);
    expect(area(rect) / want).toBeLessThan(1.02);
  });

  test('leaves no blank down the side of a corrected picture', () => {
    const keystone = keystoneFromGuides(
      [
        { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
        { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
      ],
      FRAME,
    ) as Keystone;
    const bounds: Bounds = { ...FRAME, cropAngle: 0, keystone };
    const rect = insetCrop(bounds)!;
    expect(rect).not.toBeNull();
    for (const corner of corners(rect)) {
      expect(inside(quad(bounds), corner), `${corner.x}, ${corner.y}`).toBe(true);
    }
    // A perspective correction of this size costs a fifth of the frame at most; retreating to
    // half of it would mean the search gave up rather than converged.
    expect(area(rect)).toBeGreaterThan(0.5);
  });

  /**
   * The rectangle the reader framed is what the wedges come out of.
   *
   * Off-centre on purpose: a corner of this one is a corner of the frame, so it sits under two
   * of the wedges and the answer has to move as well as shrink.
   */
  test('stays inside the rectangle it was given, and keeps most of it', () => {
    const within = { left: 0, top: 0, right: 0.5, bottom: 0.5 };
    const bounds: Bounds = { ...FRAME, cropAngle: 6, keystone: null, within };
    const rect = insetCrop(bounds)!;

    for (const corner of corners(rect)) {
      expect(inside(quad(bounds), corner), `${corner.x}, ${corner.y}`).toBe(true);
    }
    expect(rect.left).toBeGreaterThanOrEqual(within.left);
    expect(rect.top).toBeGreaterThanOrEqual(within.top);
    expect(rect.right).toBeLessThanOrEqual(within.right);
    expect(rect.bottom).toBeLessThanOrEqual(within.bottom);
    expect(area(rect) / 0.25).toBeGreaterThan(0.7);
  });

  // A slider, a degree at a time, is what this is actually used as: an answer that is correct
  // at every angle and unrelated to the answer a hundredth of a degree away is a crop that
  // teleports across the picture under the hand dragging it.
  test('moves smoothly with the angle, at the extremes as well as the middle', () => {
    const cases: { frame: typeof FRAME; within?: CropRect }[] = [
      { frame: FRAME },
      { frame: { width: 3000, height: 4000 } },
      // Off-centre, so the slide the bisection settles on is not the one symmetry would give.
      { frame: FRAME, within: { left: 0.05, top: 0.3, right: 0.55, bottom: 0.9 } },
    ];
    for (const { frame, within } of cases) {
      let previous = insetCrop({ ...frame, cropAngle: 0.02, keystone: null, within })!;
      for (let angle = 0.04; angle <= 45; angle += 0.02) {
        const rect = insetCrop({ ...frame, cropAngle: angle, keystone: null, within });
        if (rect == null) continue;
        const moved = Math.max(
          Math.abs(rect.left - previous.left),
          Math.abs(rect.top - previous.top),
          Math.abs(rect.right - previous.right),
          Math.abs(rect.bottom - previous.bottom),
        );
        // Past about 21 degrees the largest rectangle is a whole family of identical ones
        // sliding along the diagonal, and picking freely among them moved an edge by a fifth
        // of the frame for a hundredth of a degree.
        expect(moved, `${frame.width}x${frame.height} at ${angle.toFixed(2)} degrees`).toBeLessThan(0.005);
        previous = rect;
      }
    }
  });

  test('handles a straighten and a correction at once', () => {
    const keystone = keystoneFromGuides(
      [
        { x1: 0.25, y1: 0.05, x2: 0.32, y2: 0.95 },
        { x1: 0.78, y1: 0.05, x2: 0.71, y2: 0.95 },
      ],
      FRAME,
    ) as Keystone;
    const bounds: Bounds = { ...FRAME, cropAngle: -4.5, keystone };
    const rect = insetCrop(bounds)!;
    for (const corner of corners(rect)) {
      expect(inside(quad(bounds), corner), `${corner.x}, ${corner.y}`).toBe(true);
    }
    expect(area(rect)).toBeGreaterThan(0.4);
  });
});

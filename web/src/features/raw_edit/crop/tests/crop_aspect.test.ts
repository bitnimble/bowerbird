// The ratio a crop is at, and the rectangle a pick leaves.
//
// The trap the whole file is for: the rectangle is fractions and the ratio is pixels, so every
// one of these is wrong by the frame's own shape if the two are confused. A 1:1 pick that forgets
// the picture is 4:3 leaves a rectangle that is square in fractions and 4:3 on screen, which
// still looks like a crop of the same photograph.
import { describe, expect, test } from 'bun:test';
import {
  ASPECT_RATIOS,
  aspectCrop,
  aspectDraggedCrop,
  aspectKeyOf,
  aspectRatioFor,
  aspectRatioOf,
} from '../crop_aspect';
import type { CropRect } from '../crop_turn';

const PICTURE = { width: 4000, height: 3000 };
const WHOLE: CropRect = { left: 0, top: 0, right: 1, bottom: 1 };

describe('a pick of a ratio', () => {
  for (const { key, ratio } of ASPECT_RATIOS) {
    test(`leaves a rectangle that is ${key} on the picture`, () => {
      const rect = aspectCrop(WHOLE, ratio, PICTURE);
      expect(aspectRatioOf(rect, PICTURE)).toBeCloseTo(ratio, 10);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(1);
      expect(rect.bottom).toBeLessThanOrEqual(1);
    });
  }

  test('keeps the whole of the axis it does not have to trim', () => {
    // 16:9 is wider than the 4:3 frame, so the height gives and the width is untouched.
    const wide = aspectCrop(WHOLE, 16 / 9, PICTURE);
    expect(wide.left).toBe(0);
    expect(wide.right).toBe(1);
    expect(wide.bottom - wide.top).toBeCloseTo((9 / 16) * (4000 / 3000), 10);
  });

  test('stays where the rectangle was rather than jumping to the middle', () => {
    const corner: CropRect = { left: 0, top: 0, right: 0.4, bottom: 0.4 };
    const square = aspectCrop(corner, 1, PICTURE);
    expect((square.left + square.right) / 2).toBeCloseTo(0.2, 10);
    expect((square.top + square.bottom) / 2).toBeCloseTo(0.2, 10);
    expect(aspectRatioOf(square, PICTURE)).toBeCloseTo(1, 10);
  });

  test('never grows the rectangle it was given', () => {
    const rect: CropRect = { left: 0.3, top: 0.2, right: 0.7, bottom: 0.9 };
    for (const { ratio } of ASPECT_RATIOS) {
      const next = aspectCrop(rect, ratio, PICTURE);
      expect(next.right - next.left).toBeLessThanOrEqual(rect.right - rect.left + 1e-12);
      expect(next.bottom - next.top).toBeLessThanOrEqual(rect.bottom - rect.top + 1e-12);
    }
  });
});

describe('the ratio the picker shows', () => {
  const original = PICTURE.width / PICTURE.height;

  test('is the frame own shape for an uncropped frame, not the ratio that matches it', () => {
    expect(aspectKeyOf(WHOLE, PICTURE, original)).toBe('original');
  });

  test('names whichever ratio a pick left', () => {
    for (const { key, ratio } of ASPECT_RATIOS) {
      // 4:3 is this frame's own shape, so it reads as that rather than as itself.
      const want = key === '4:3' ? 'original' : key;
      expect(aspectKeyOf(aspectCrop(WHOLE, ratio, PICTURE), PICTURE, original)).toBe(want);
    }
  });

  test('is custom for a shape nobody offered', () => {
    expect(aspectKeyOf({ left: 0, top: 0, right: 0.9, bottom: 0.31 }, PICTURE, original)).toBe(
      'custom',
    );
  });

  test('has nothing to hand back for custom', () => {
    expect(aspectRatioFor('custom', original)).toBeNull();
    expect(aspectRatioFor('original', original)).toBe(original);
    expect(aspectRatioFor('16:9', original)).toBeCloseTo(16 / 9, 10);
  });
});

describe('a drag held at a ratio', () => {
  // 1200 by 1200 on the picture.
  const SQUARE: CropRect = { left: 0.25, top: 0.2, right: 0.55, bottom: 0.6 };

  const expectRect = (got: CropRect, want: CropRect): void => {
    expect(got.left).toBeCloseTo(want.left, 10);
    expect(got.top).toBeCloseTo(want.top, 10);
    expect(got.right).toBeCloseTo(want.right, 10);
    expect(got.bottom).toBeCloseTo(want.bottom, 10);
  };

  test('grows a corner along the diagonal, from the corner opposite', () => {
    const got = aspectDraggedCrop(SQUARE, { x: 'right', y: 'bottom' }, { x: 0.15, y: 0 }, 1, PICTURE);
    expectRect(got, { left: 0.25, top: 0.2, right: 0.625, bottom: 0.7 });
  });

  test('shrinks a corner the same way', () => {
    const got = aspectDraggedCrop(SQUARE, { x: 'left', y: 'top' }, { x: 0.1, y: 0.1 }, 1, PICTURE);
    expectRect(got, { left: 0.3375, top: 0.6 - 850 / 3000, right: 0.55, bottom: 0.6 });
  });

  test('grows a side about the middle of the side opposite', () => {
    const got = aspectDraggedCrop(SQUARE, { x: 'right', y: null }, { x: 0.15, y: 0 }, 1, PICTURE);
    expectRect(got, { left: 0.25, top: 0.1, right: 0.7, bottom: 0.7 });
  });

  test('stops at the frame rather than leave it or change shape', () => {
    const got = aspectDraggedCrop(SQUARE, { x: 'right', y: 'bottom' }, { x: 1, y: 1 }, 1, PICTURE);
    expectRect(got, { left: 0.25, top: 0.2, right: 0.85, bottom: 1 });
  });

  test('turns a corner portrait once the pointer crosses the diagonal, and back', () => {
    // 1200 by 900, which is 4:3.
    const wide: CropRect = { left: 0.1, top: 0.1, right: 0.4, bottom: 0.4 };
    const se = { x: 'right', y: 'bottom' } as const;

    const tall = aspectDraggedCrop(wide, se, { x: 0, y: 0.3 }, 4 / 3, PICTURE);
    expectRect(tall, { left: 0.1, top: 0.1, right: 0.424, bottom: 0.676 });
    expect(aspectRatioOf(tall, PICTURE)).toBeCloseTo(3 / 4, 10);

    expect(aspectRatioOf(aspectDraggedCrop(wide, se, { x: 0, y: 0.05 }, 4 / 3, PICTURE), PICTURE)).toBeCloseTo(
      4 / 3,
      10,
    );
    // Held as its portrait form, the same pointer gives the same answers.
    expect(aspectRatioOf(aspectDraggedCrop(wide, se, { x: 0, y: 0.05 }, 3 / 4, PICTURE), PICTURE)).toBeCloseTo(
      4 / 3,
      10,
    );
  });

  test('keeps a side in the orientation it started in, however far it goes', () => {
    const got = aspectDraggedCrop(SQUARE, { x: null, y: 'bottom' }, { x: 0, y: 0.4 }, 16 / 9, PICTURE);
    expect(aspectRatioOf(got, PICTURE)).toBeCloseTo(16 / 9, 10);
  });

  test('keeps the ratio, in one orientation or the other, from every grip, however far', () => {
    const grips = [
      { x: 'left', y: 'top' },
      { x: null, y: 'top' },
      { x: 'right', y: 'top' },
      { x: 'right', y: null },
      { x: 'right', y: 'bottom' },
      { x: null, y: 'bottom' },
      { x: 'left', y: 'bottom' },
      { x: 'left', y: null },
    ] as const;
    for (const grip of grips) {
      for (const by of [{ x: 0.9, y: -0.9 }, { x: -0.9, y: 0.9 }, { x: 0.05, y: 0.02 }]) {
        const got = aspectDraggedCrop(SQUARE, grip, by, 16 / 9, PICTURE);
        const ratio = aspectRatioOf(got, PICTURE);
        expect(Math.max(ratio, 1 / ratio)).toBeCloseTo(16 / 9, 10);
        expect(got.left).toBeGreaterThanOrEqual(-1e-12);
        expect(got.top).toBeGreaterThanOrEqual(-1e-12);
        expect(got.right).toBeLessThanOrEqual(1 + 1e-12);
        expect(got.bottom).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
  });

  test('never goes below the smallest crop, even against an edge with no room for it', () => {
    // 90 pixels below the anchor, where a 9:16 crop the minimum 80 wide needs 142.
    const low: CropRect = { left: 0.9, top: 0.97, right: 0.98, bottom: 0.99 };
    const got = aspectDraggedCrop(low, { x: 'right', y: 'bottom' }, { x: -0.06, y: 0.5 }, 9 / 16, PICTURE);
    expect(got.right - got.left).toBeCloseTo(0.02, 10);
    expect(aspectRatioOf(got, PICTURE)).toBeCloseTo(9 / 16, 10);
    expect(got.top).toBeGreaterThanOrEqual(0);
    expect(got.bottom).toBeCloseTo(1, 10);
  });

  test('moves the whole rectangle as a free drag does', () => {
    expectRect(aspectDraggedCrop(SQUARE, null, { x: 0.1, y: 0.1 }, 1, PICTURE), {
      left: 0.35,
      top: 0.3,
      right: 0.65,
      bottom: 0.7,
    });
  });
});

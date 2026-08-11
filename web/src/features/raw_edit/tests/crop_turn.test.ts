// The crop fractions through a quarter turn, and back.
//
// The document defines them against the straightened frame *before* the turn, and the overlay
// lays itself out on the picture *after* it - so one of them has to be permuted, twice, in
// opposite directions. Getting one of the eight terms wrong swaps or mirrors a crop, which
// looks like a plausible crop of the same photograph and is caught by nothing else: the edges
// are all fractions in the same range, and the picture is still a picture.
import { describe, expect, test } from 'bun:test';
import {
  MINIMUM_CROP,
  draggedCrop,
  turnedForDisplay,
  turnedForDocument,
  turnedPointForDisplay,
  turnedPointForDocument,
  type CropRect,
} from '../crop_turn';

const CASES: CropRect[] = [
  { left: 0.1, top: 0.2, right: 0.7, bottom: 0.9 },
  { left: 0, top: 0, right: 1, bottom: 1 },
  { left: 0.42, top: 0.05, right: 0.44, bottom: 0.95 },
];

/**
 * Edge by edge, to a tolerance.
 *
 * The permutations are exact in arithmetic and not in binary: `1 - (1 - 0.1)` is
 * 0.09999999999999998, so a round trip through two mirrorings lands a few ulps out. That is
 * a ten-thousandth of a pixel on a 6000px frame and worth nothing; what these tests are for is
 * an edge that came back as a *different* edge.
 */
function expectSame(got: CropRect, want: CropRect): void {
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    expect(got[edge], edge).toBeCloseTo(want[edge], 10);
  }
}

describe('a crop through a quarter turn', () => {
  for (const rotate of [0, 90, 180, 270] as const) {
    test(`comes back the same at ${rotate} degrees`, () => {
      for (const crop of CASES) {
        expectSame(turnedForDocument(turnedForDisplay(crop, rotate), rotate), crop);
      }
    });
  }

  // Direction, not just reversibility: an inverse pair can agree with each other and still both
  // be wrong, and a mirrored crop is still a crop of the same photograph.
  test('sends the top edge to the right-hand one at 90 degrees', () => {
    // A band across the top of the picture, turned right, is a band down its right side.
    expectSame(turnedForDisplay({ left: 0, top: 0, right: 1, bottom: 0.25 }, 90), {
      left: 0.75,
      top: 0,
      right: 1,
      bottom: 1,
    });
  });

  test('sends the top edge to the left-hand one at 270 degrees', () => {
    expectSame(turnedForDisplay({ left: 0, top: 0, right: 1, bottom: 0.25 }, 270), {
      left: 0,
      top: 0,
      right: 0.25,
      bottom: 1,
    });
  });

  test('mirrors both axes at 180 degrees', () => {
    // Asymmetric on both axes. A rectangle centred vertically comes back to itself under a
    // horizontal mirror alone, so it would pass this *and* the round trip - the vertical half
    // of 180 would be unpinned by the whole file.
    expectSame(turnedForDisplay({ left: 0.1, top: 0.2, right: 0.6, bottom: 0.7 }, 180), {
      left: 0.4,
      top: 0.3,
      right: 0.9,
      bottom: 0.8,
    });
  });

  // The bands above are full-width, so they read the same under a mirror of the source; a
  // rectangle with four different edges is what tells a turn from a turn-and-flip.
  test('carries a corner to the corner a turn puts it at', () => {
    const crop = CASES[0]!;
    expectSame(turnedForDisplay(crop, 90), { left: 0.1, top: 0.1, right: 0.8, bottom: 0.7 });
    expectSame(turnedForDisplay(crop, 270), { left: 0.2, top: 0.3, right: 0.9, bottom: 0.9 });
  });

  test('leaves an unturned crop alone', () => {
    expectSame(turnedForDisplay(CASES[0]!, 0), CASES[0]!);
  });
});

describe('a point through the same turn', () => {
  const POINTS = [
    { x: 0.1, y: 0.2 },
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 0.5, y: 0.5 },
  ];

  for (const rotate of [0, 90, 180, 270] as const) {
    test(`comes back the same at ${rotate} degrees`, () => {
      for (const point of POINTS) {
        const back = turnedPointForDocument(turnedPointForDisplay(point, rotate), rotate);
        expect(back.x, 'x').toBeCloseTo(point.x, 10);
        expect(back.y, 'y').toBeCloseTo(point.y, 10);
      }
    });
  }

  // The pair has to agree with the rectangle's, or a guide and a crop drawn on the same picture
  // would disagree about which way it had been turned.
  test('turns a rectangle the way the rectangle does', () => {
    for (const rotate of [0, 90, 180, 270] as const) {
      const crop: CropRect = { left: 0.1, top: 0.2, right: 0.7, bottom: 0.9 };
      const a = turnedPointForDisplay({ x: crop.left, y: crop.top }, rotate);
      const b = turnedPointForDisplay({ x: crop.right, y: crop.bottom }, rotate);
      const shown = turnedForDisplay(crop, rotate);
      expect(Math.min(a.x, b.x), `left at ${rotate}`).toBeCloseTo(shown.left, 10);
      expect(Math.min(a.y, b.y), `top at ${rotate}`).toBeCloseTo(shown.top, 10);
      expect(Math.max(a.x, b.x), `right at ${rotate}`).toBeCloseTo(shown.right, 10);
      expect(Math.max(a.y, b.y), `bottom at ${rotate}`).toBeCloseTo(shown.bottom, 10);
    }
  });
});

describe('a drag of the rectangle', () => {
  const start: CropRect = { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 };

  test('moves only the edges its grip owns', () => {
    expectSame(draggedCrop(start, { x: 'right', y: 'bottom' }, { x: -0.1, y: -0.2 }), {
      left: 0.2,
      top: 0.2,
      right: 0.7,
      bottom: 0.6,
    });
    expectSame(draggedCrop(start, { x: null, y: 'top' }, { x: 0.5, y: 0.1 }), {
      left: 0.2,
      top: 0.3,
      right: 0.8,
      bottom: 0.8,
    });
  });

  test('holds an edge off the one opposite it', () => {
    // Dragging the left edge past the right does not invert the rectangle, and does not leave
    // one too narrow to have a grip on each side of it.
    expectSame(draggedCrop(start, { x: 'left', y: null }, { x: 0.9, y: 0 }), {
      left: 0.8 - MINIMUM_CROP,
      top: 0.2,
      right: 0.8,
      bottom: 0.8,
    });
  });

  test('keeps its shape when the whole rectangle is dragged into a corner', () => {
    // Edge by edge, clamping would stop `left` at 0 while `right` kept going, and a rectangle
    // pushed into a corner would come out a different size from the one that went in.
    expectSame(draggedCrop(start, null, { x: -0.5, y: -0.5 }), {
      left: 0,
      top: 0,
      right: 0.6,
      bottom: 0.6,
    });
    expectSame(draggedCrop(start, null, { x: 0.5, y: 0.5 }), {
      left: 0.4,
      top: 0.4,
      right: 1,
      bottom: 1,
    });
  });
});

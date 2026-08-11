// The keystone correction, against the one thing it promises: the lines the reader drew come
// out parallel.
//
// Asserted that way round on purpose. Comparing the matrix against a matrix would pin the
// arithmetic to whatever it happened to produce the first time; "these two lines are parallel
// afterwards" is the claim the tool makes to the reader, and it fails for any error that
// matters - a transposed row, a vanishing point taken from the wrong pair, a horizon of the
// wrong sign - while staying silent about the ones that do not, like which uniform scale was
// chosen to fit the result back into the frame.
import { describe, expect, test } from 'bun:test';
import {
  keystoneFromGuides,
  keystoneShows,
  keystonedLine,
  type Keystone,
  type KeystoneGuide,
} from '../keystone';

const FRAME = { width: 4000, height: 3000 };

/**
 * How far two corrected lines are from parallel, as the weight of the point they meet at.
 *
 * Zero is parallel - the meeting point is at infinity - and the value is scaled by the two
 * directions so it reads the same for a long line and a short one. Parallelism survives any
 * affine change, so this is as true in fractions as in pixels.
 */
function meetsAtInfinity(keystone: Keystone, a: KeystoneGuide, b: KeystoneGuide): number {
  const [ax, ay, ac] = keystonedLine(keystone, a);
  const [bx, by, bc] = keystonedLine(keystone, b);
  const w = ax * by - ay * bx;
  const size = Math.hypot(ax, ay, ac) * Math.hypot(bx, by, bc);
  return Math.abs(w) / size;
}

describe('a keystone from the lines the reader drew', () => {
  // A building shot from below: its two vertical edges lean towards each other.
  const leaning: KeystoneGuide[] = [
    { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 },
    { x1: 0.8, y1: 0.05, x2: 0.7, y2: 0.95 },
  ];

  test('makes two leaning uprights parallel', () => {
    const keystone = keystoneFromGuides(leaning, FRAME);
    expect(keystone).not.toBeNull();
    expect(meetsAtInfinity(keystone!, leaning[0]!, leaning[1]!)).toBeLessThan(1e-9);
  });

  test('stands a symmetric pair upright, rather than parallel and leaning', () => {
    // **Parallel is not the whole claim.** Any two lines can be made parallel by a map that
    // also tips the pair over as a block, and a parallelism test cannot tell the two apart -
    // it is invariant under exactly that. Written about the frame's corner rather than its
    // middle, the correction did tip them: sixteen degrees, on a symmetric leaning building.
    // A symmetric input has an unambiguous answer, so this asks for it directly.
    const keystone = keystoneFromGuides(leaning, FRAME)!;

    for (const guide of leaning) {
      const [a, b] = keystonedLine(keystone, guide);
      // `ax + by + c = 0` is vertical exactly when `b` is zero.
      expect(Math.abs(b) / Math.hypot(a, b)).toBeLessThan(1e-9);
    }
  });

  test('leaves the horizontals alone when only the uprights were named', () => {
    // **The claim that pins which horizon was chosen.** One pair fixes a vanishing point, and
    // every line through it sends that point to infinity - a whole family of corrections, all
    // of which make the two guides parallel and all but one of which shear the picture. The one
    // this takes is the *horizontal* line through it, so a line that was level stays level.
    // Without this, a horizon tilted by any amount passes every other test in this file.
    const keystone = keystoneFromGuides(leaning, FRAME)!;
    const [a, b] = keystonedLine(keystone, { x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5 });

    // `ax + by + c = 0` is horizontal exactly when `a` is zero.
    expect(Math.abs(a) / Math.hypot(a, b)).toBeLessThan(1e-9);
  });

  test('makes both pairs parallel at once', () => {
    const both: KeystoneGuide[] = [
      ...leaning,
      { x1: 0.05, y1: 0.25, x2: 0.95, y2: 0.18 },
      { x1: 0.05, y1: 0.75, x2: 0.95, y2: 0.85 },
    ];
    const keystone = keystoneFromGuides(both, FRAME);
    expect(keystone).not.toBeNull();
    expect(meetsAtInfinity(keystone!, both[0]!, both[1]!)).toBeLessThan(1e-9);
    expect(meetsAtInfinity(keystone!, both[2]!, both[3]!)).toBeLessThan(1e-9);
  });

  test('asks for nothing from lines that are already parallel', () => {
    expect(
      keystoneFromGuides(
        [
          { x1: 0.3, y1: 0.1, x2: 0.3, y2: 0.9 },
          { x1: 0.7, y1: 0.1, x2: 0.7, y2: 0.9 },
        ],
        FRAME,
      ),
    ).toBeNull();
  });

  test('asks for nothing from a single line, or none', () => {
    expect(keystoneFromGuides([], FRAME)).toBeNull();
    expect(keystoneFromGuides([{ x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 }], FRAME)).toBeNull();
  });

  test('refuses guides that cross inside the picture', () => {
    // Their vanishing point is in the middle of the frame, so the horizon runs through it: the
    // correction would fold the photograph through that line and mirror half of it.
    expect(
      keystoneFromGuides(
        [
          { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 },
          { x1: 0.9, y1: 0.1, x2: 0.1, y2: 0.9 },
        ],
        FRAME,
      ),
    ).toBeNull();
  });

  test('keeps the whole corrected picture inside the frame', () => {
    // Fitted rather than filled: every corner of the picture lands within the frame, so nothing
    // the reader corrected is thrown away before they have seen it. The blank wedges this
    // leaves are what the crop tool is for.
    const keystone = keystoneFromGuides(leaning, FRAME)!;
    for (const corner of [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]) {
      const at = keystoneShows(keystone, corner.x, corner.y);
      expect(at).not.toBeNull();
      expect(at!.x).toBeGreaterThanOrEqual(-1e-6);
      expect(at!.x).toBeLessThanOrEqual(1 + 1e-6);
      expect(at!.y).toBeGreaterThanOrEqual(-1e-6);
      expect(at!.y).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  test('leaves the middle of the picture its own proportions', () => {
    // Sending a vanishing point to infinity scales along the picture by `1/w` and across it by
    // `1/w²`, so it cannot keep every shape - what it can do is put the middle of the frame at
    // the neutral point instead of leaving the whole subject on the squeezed side of it.
    const keystone = keystoneFromGuides(leaning, FRAME)!;
    const step = 1e-4;
    const at = keystoneShows(keystone, 0.5, 0.5)!;
    const alongX = keystoneShows(keystone, 0.5 + step, 0.5)!;
    const alongY = keystoneShows(keystone, 0.5, 0.5 + step)!;
    // The scales along each axis, not the lengths of the mapped steps: a correction shears as
    // well as scales, and one parameter cannot take out both. What is being normalised - and
    // what reads as "stretched" - is the scales.
    const across = ((alongX.x - at.x) * FRAME.width) / (step * FRAME.width);
    const down = ((alongY.y - at.y) * FRAME.height) / (step * FRAME.height);
    expect(across / down).toBeCloseTo(1, 3);
  });

  test('centres what it corrected, and fills the frame in one direction', () => {
    // The *picture* is centred, which is not the same as its middle staying put: a perspective
    // correction moves the centre of a frame by design, and pinning that would be pinning the
    // correction to nothing. What is centred is the box the corrected picture occupies - and
    // the fit is tight, so it meets the frame on one pair of edges.
    const keystone = keystoneFromGuides(leaning, FRAME)!;
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ].map((corner) => keystoneShows(keystone, corner.x, corner.y)!);
    const left = Math.min(...corners.map((p) => p.x));
    const right = Math.max(...corners.map((p) => p.x));
    const top = Math.min(...corners.map((p) => p.y));
    const bottom = Math.max(...corners.map((p) => p.y));

    expect((left + right) / 2).toBeCloseTo(0.5, 6);
    expect((top + bottom) / 2).toBeCloseTo(0.5, 6);
    expect(Math.min(right - left, bottom - top)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.max(right - left, bottom - top)).toBeCloseTo(1, 6);
  });
});

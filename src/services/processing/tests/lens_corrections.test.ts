import { describe, expect, test } from 'bun:test';
import { polynomialKnots, sampleRadius, SPLINE_UNIT } from '../lens_corrections';

describe('sampleRadius', () => {
  test('leaves the centre alone and scales the corner by the last knot', () => {
    const knots = [0, 0, 0, SPLINE_UNIT / 10];
    expect(sampleRadius(knots, 0, 1)).toBeCloseTo(0, 6);
    expect(sampleRadius(knots, 1, 1)).toBeCloseTo(1.1, 6);
  });

  test('applies the crop on top of the spline', () => {
    // The spline is anchored at the centre and carries no rescale, so the crop is
    // what stops a pincushion correction sampling outside the frame.
    const knots = [0, 0, 0, SPLINE_UNIT * 0.0452];
    expect(sampleRadius(knots, 1, 0.9568)).toBeCloseTo(0.9568 * 1.0452, 4);
  });

  test('interpolates between knots', () => {
    const knots = [0, SPLINE_UNIT];
    expect(sampleRadius(knots, 0.5, 1)).toBeCloseTo(0.5 * 1.5, 6);
  });

  test('is the identity scaled by the crop when there are no knots', () => {
    expect(sampleRadius([], 0.7, 0.98)).toBeCloseTo(0.7 * 0.98, 6);
  });
});

describe('polynomialKnots', () => {
  test('encodes a radial polynomial in the same units as a camera spline', () => {
    const knots = polynomialKnots(0.045, 0);
    expect(knots[0]).toBe(0);
    expect(knots[knots.length - 1]! / SPLINE_UNIT).toBeCloseTo(0.045, 4);
  });

  test('round-trips through sampleRadius', () => {
    const k1 = -0.0275;
    const knots = polynomialKnots(k1, 0, 64);
    // The fitted fallback and the camera's spline have to be interchangeable
    // downstream, so a polynomial expressed as knots must behave like the
    // polynomial it came from.
    expect(sampleRadius(knots, 1, 1)).toBeCloseTo(1 + k1, 3);
    expect(sampleRadius(knots, 0.5, 1)).toBeCloseTo(0.5 * (1 + k1 * 0.25), 3);
  });
});

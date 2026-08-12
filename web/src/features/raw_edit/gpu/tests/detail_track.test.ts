// The Detail track's landmarks, on this side of it.
//
// **Two implementations of one scale, and this is half of the guard.** The rendition path maps
// the same slider through `Amounts::from_sliders` in `galosh.rs`, in another language, and
// nothing but arithmetic keeps the two agreeing - so each side pins its own landmarks against
// the number rather than against the other's source. The colour halves already differ on
// purpose: the mosaic path walks four anchors where this has a scale and a dry/wet mix.
//
// The failure this guards is silent. A mapping that drifted would not throw; it would ship one
// denoise in the editor and a different one in the export, and the reader would find out by
// comparing a preview against a file.
import { describe, expect, test } from 'bun:test';
import { denoiseAmounts } from '../shaders';

describe('the Detail track', () => {
  test('treats exactly the measured noise at its middle', () => {
    // 50 is the calibrated point: the plane is normalised to its own sigma before the shrinkage
    // runs, so an amount of 1.0 is "remove what the frame was measured to have".
    expect(denoiseAmounts(50, 50).luma).toBeCloseTo(1.0, 6);
    expect(denoiseAmounts(50, 50).blend).toBeCloseTo(1.0, 6);
  });

  test('ships four fifths of that by default', () => {
    // Deliberately short of the mark: below it a frame keeps grain, above it the frame smears,
    // and only the first still reads as a photograph.
    expect(denoiseAmounts(40, 40).luma).toBeCloseTo(0.8, 6);
  });

  test('leaves the top half as headroom rather than a limit', () => {
    // An envelope over the quiet blocks is a good estimate and not an infallible one, so a
    // reader who goes past the middle is overriding a measurement, not turning a knob past a
    // stop. Colour keeps going by widening the regression rather than by blending further.
    expect(denoiseAmounts(100, 100).luma).toBeCloseTo(2.0, 6);
    expect(denoiseAmounts(100, 100).blend).toBeCloseTo(1.0, 6);
    expect(denoiseAmounts(100, 100).ridge).toBeGreaterThan(denoiseAmounts(50, 50).ridge);
  });

  test('does nothing at rest, and clamps rather than inverting past the ends', () => {
    expect(denoiseAmounts(0, 0).luma).toBe(0);
    expect(denoiseAmounts(0, 0).blend).toBe(0);
    expect(denoiseAmounts(-20, -20).luma).toBe(0);
    expect(denoiseAmounts(180, 180).luma).toBeCloseTo(2.0, 6);
  });
});

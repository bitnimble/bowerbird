import { describe, expect, test } from 'bun:test';
import { cameraMultipliers } from '../raw_decoder';

describe('cameraMultipliers', () => {
  test('normalises the as-shot multipliers to green', () => {
    // A real ILCE-7CR set, as reported by LibRaw.
    expect(cameraMultipliers([2770, 1024, 1669, 1024])).toEqual([2770 / 1024, 1, 1669 / 1024, 1]);
  });

  test('substitutes green for a three-colour camera\'s absent fourth channel', () => {
    // Reporting 0 here is legitimate, not corruption, so it must not veto the
    // whole set - that would skip white balance on exactly those bodies.
    expect(cameraMultipliers([2060, 1024, 2904, 0])).toEqual([2060 / 1024, 1, 2904 / 1024, 1]);
  });

  test('refuses the set when any of R, G or B is missing', () => {
    // These go straight into user_mul, so a single zero would zero that channel in
    // the render. Falling back to LibRaw's default is the lesser evil.
    expect(cameraMultipliers([0, 1024, 1669, 1024])).toBeNull();
    expect(cameraMultipliers([2770, 0, 1669, 1024])).toBeNull();
    expect(cameraMultipliers([2770, 1024, 0, 1024])).toBeNull();
  });

  test('refuses negative multipliers, which would invert a channel', () => {
    expect(cameraMultipliers([2770, 1024, -1669, 1024])).toBeNull();
    expect(cameraMultipliers([2770, -1024, 1669, 1024])).toBeNull();
  });

  test('refuses a short or empty set rather than reading undefined as zero', () => {
    expect(cameraMultipliers([])).toBeNull();
    expect(cameraMultipliers([2770, 1024])).toBeNull();
  });

  test('never returns a non-positive multiplier', () => {
    for (const camMul of [
      [2770, 1024, 1669, 1024],
      [2060, 1024, 2904, 0],
      [1, 1, 1, -5],
    ]) {
      const result = cameraMultipliers(camMul);
      if (result == null) continue;
      for (const value of result) expect(value).toBeGreaterThan(0);
    }
  });
});

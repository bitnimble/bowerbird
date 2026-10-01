import { describe, expect, test } from 'bun:test';
import { preparesOnTheBackend } from '../prepare_choice';

const A_TAB = {} as const;

/** A photograph of this size, opened from its own file. */
function sized(width: number, height: number) {
  return { composite_kind: null, width, height };
}

describe('which device prepares the picture', () => {
  test('a composite always goes to the server, however small its canvas', () => {
    // Six 1280x800 views compose about five megapixels, nowhere near the ceiling - and the tab's
    // open downloads the photograph's own bytes, which a recipe over several others has none of.
    const panorama = (width: number, height: number) => ({
      composite_kind: 'panorama' as const,
      width,
      height,
    });
    expect(preparesOnTheBackend(panorama(2700, 1600), A_TAB)).toBe(true);
    expect(preparesOnTheBackend(panorama(29_000, 7000), A_TAB)).toBe(true);
  });

  test('a picture a tab can hold is prepared in the tab', () => {
    expect(preparesOnTheBackend(sized(6000, 4000), A_TAB)).toBe(false);
    expect(preparesOnTheBackend(sized(9504, 6336), A_TAB)).toBe(false);
  });

  test('the ceiling is an area, so a long thin picture is judged like a square one', () => {
    expect(preparesOnTheBackend(sized(10_000, 10_000), A_TAB)).toBe(false);
    expect(preparesOnTheBackend(sized(10_000, 10_001), A_TAB)).toBe(true);
    // 120MP either way round.
    expect(preparesOnTheBackend(sized(12_000, 10_000), A_TAB)).toBe(true);
    expect(preparesOnTheBackend(sized(10_000, 12_000), A_TAB)).toBe(true);
  });

  test('a small-memory device goes to the server, where the browser reports one', () => {
    expect(preparesOnTheBackend(sized(6000, 4000), { memoryGb: 4 })).toBe(true);
    expect(preparesOnTheBackend(sized(6000, 4000), { memoryGb: 8 })).toBe(false);
  });
});

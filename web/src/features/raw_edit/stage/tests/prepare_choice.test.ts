import { describe, expect, test } from 'bun:test';
import { preparesOnTheBackend } from '../prepare_choice';
import type { StoredRecipe } from '../../../../../../src/schemas/recipes';

const A_TAB = {} as const;
const FILE: StoredRecipe = { kind: 'file', path: 'a.arw' };

function panorama(canvas: [number, number]): StoredRecipe {
  return {
    kind: 'panorama',
    version: 1,
    sources: [],
    projection: 'cylindrical',
    canvas,
    centre: [canvas[0] / 2, canvas[1] / 2],
    radiansPerPixel: 1 / 5200,
    crop: [0, 0, 1, 1],
    reference: 0,
  } as StoredRecipe;
}

/** A photograph of this size, for a recipe that is its own file. */
function sized(width: number, height: number): { width: number; height: number } {
  return { width, height };
}

describe('which device prepares the picture', () => {
  test('a composite always goes to the server, however small its canvas', () => {
    // Six 1280x800 views compose about five megapixels, nowhere near the ceiling - and the tab's
    // open downloads the photograph's own bytes, which a recipe over several others has none of.
    // So this is decided by the recipe and not by the size.
    expect(preparesOnTheBackend(panorama([2800, 1700]), sized(2700, 1600), A_TAB)).toBe(true);
    expect(preparesOnTheBackend(panorama([30_000, 8000]), sized(29_000, 7000), A_TAB)).toBe(true);
  });

  test('a recipe this build cannot read goes the same way', () => {
    // A peer on a later build composed it out of something unknown here, so there is no file
    // named in it to open either.
    expect(preparesOnTheBackend({ kind: 'unreadable' }, sized(6000, 4000), A_TAB)).toBe(true);
  });

  test('a picture a tab can hold is prepared in the tab', () => {
    expect(preparesOnTheBackend(FILE, sized(6000, 4000), A_TAB)).toBe(false);
    expect(preparesOnTheBackend(FILE, sized(9504, 6336), A_TAB)).toBe(false);
  });

  test('the ceiling is an area, so a long thin picture is judged like a square one', () => {
    expect(preparesOnTheBackend(FILE, sized(10_000, 10_000), A_TAB)).toBe(false);
    expect(preparesOnTheBackend(FILE, sized(10_000, 10_001), A_TAB)).toBe(true);
    // 120MP either way round.
    expect(preparesOnTheBackend(FILE, sized(12_000, 10_000), A_TAB)).toBe(true);
    expect(preparesOnTheBackend(FILE, sized(10_000, 12_000), A_TAB)).toBe(true);
  });

  test('a small-memory device goes to the server, where the browser reports one', () => {
    expect(preparesOnTheBackend(FILE, sized(6000, 4000), { memoryGb: 4 })).toBe(true);
    expect(preparesOnTheBackend(FILE, sized(6000, 4000), { memoryGb: 8 })).toBe(false);
  });
});

// Which level and which rectangle of it a client showing a region is served.
//
// The whole of what the ladder is: a reader opens on a level that fits their device and reaches
// the canvas's own pixels by asking for a window of a finer one. Every number is this side's, so
// this is where the arithmetic is held.
import { describe, expect, test } from 'bun:test';
import { pictureLevel, type Shown } from '../prepare_pool';
import {
  COARSEST_LONG,
  STAGE_SUPERSAMPLE,
  coarsestLevel,
  levelSize,
} from '../../../../schemas/prepare_levels';

/**
 * A tile's side, as the module cuts them (`wasm::TILE`).
 *
 * Stated here rather than imported, because the grid is the module's alone: it owns the tiles, so
 * it is what answers which of them are missing, and this side only ever forwards the rectangle
 * they span. What the number is for here is writing requests a client would really send.
 */
const TILE = 1024;
import type { StoredRecipe } from '../../../../schemas/recipes';

/** A panorama whose canvas is far past what any adapter holds a whole level of. */
const PAN: StoredRecipe = {
  kind: 'panorama',
  version: 1,
  sources: [],
  projection: 'cylindrical',
  canvas: [33804, 9376],
  centre: [16902, 4688],
  radiansPerPixel: 1 / 5200,
  crop: [0, 0, 1, 1],
  reference: 0,
  seamRmsPx: null,
} as unknown as StoredRecipe;

const FILE: StoredRecipe = { kind: 'file', path: 'DSC00853.ARW' } as unknown as StoredRecipe;

/** The row's own dimensions, which for a composite are the canvas already framed. */
const ROW = { width: 33804, height: 9376 };

function showing(region: [number, number, number, number], stage: number): Shown {
  const [x = 0, y = 0, width = 1, height = 1] = region;
  return { region: { x, y, width, height }, stage };
}

describe('pictureLevel', () => {
  test('serves the whole coarsest level when the client says nothing', () => {
    const at = pictureLevel(PAN, ROW);
    expect(at).not.toBeNull();
    expect(at?.window).toBeUndefined();
    // 33804 halved three times is 4225, which is over the ceiling; four times is 2112.
    expect(at?.level).toBe(4);
    expect(at?.size.width).toBeGreaterThan(2112);
  });

  test('a composite is sized by its canvas rather than by its row', () => {
    // The row holds what the align's framing leaves, and a framed row would pick a level from a
    // long edge the recipe never has - a picture of the wrong size, sized for a buffer of another.
    const framed = pictureLevel(PAN, { width: 800, height: 600 });
    const whole = pictureLevel(PAN, ROW);
    expect(framed).toEqual(whole);
  });

  test('a region filling the stage comes back as a window of a finer level', () => {
    // A twentieth of the canvas across - 1690 pixels of it - shown on a 1600px stage. At the
    // coarsest level that rectangle is 105 pixels, which the stage would magnify sixteen times.
    const at = pictureLevel(PAN, ROW, showing([0.4, 0.3, 0.05, 0.2], 1600));
    expect(at?.level).toBe(0);
    const window = at?.window;
    expect(window).toBeDefined();
    const [left = 0, top = 0, width = 0, height = 0] = window ?? [];
    // Around where it asked for, **in the level's own pixels** - which for this canvas are not the
    // picture's: a composite is never assembled past `MAX_LONG_EDGE`, so level 0 of 33804 is
    // 16384 across and a fraction of the picture maps through that.
    const level = levelSize(ROW.width, ROW.height, at?.level ?? 0);
    expect(left).toBeLessThanOrEqual(0.4 * level.width);
    expect(top).toBeLessThanOrEqual(0.3 * level.height);
    // The window reaches past the region on every side, so a pan has somewhere to go before it
    // costs another fetch.
    expect(left + width).toBeGreaterThanOrEqual(0.45 * level.width);
    expect(top + height).toBeGreaterThanOrEqual(0.5 * level.height);
    // And not much past it: a margin that grew the window by more than it saves would cost more
    // bytes than the fetches it avoids.
    expect(width).toBeLessThan(0.05 * level.width * 1.5);
    // The buffer is sized for the window, not for the level: a whole level 0 of this canvas is
    // 450MB of samples.
    expect(at?.size.width).toBeLessThan(1400);
  });

  test('a window is asked for in even columns, which a frame two samples to a word needs', () => {
    for (const fraction of [0.0001, 0.137, 0.333, 0.5, 0.71, 0.9999]) {
      const at = pictureLevel(PAN, ROW, showing([fraction, fraction, 0.03, 0.03], 900));
      const [left = 1, , width = 1] = at?.window ?? [];
      expect(left % 2, `left for ${fraction}`).toBe(0);
      expect(width % 2, `width for ${fraction}`).toBe(0);
    }
  });

  test('a window never runs off the level it is cut from', () => {
    const at = pictureLevel(PAN, ROW, showing([0.98, 0.97, 0.5, 0.5], 1200));
    const [left = 0, top = 0, width = 0, height = 0] = at?.window ?? [];
    const scale = 1 / 2 ** (at?.level ?? 0);
    expect(left + width).toBeLessThanOrEqual(Math.ceil(33804 * scale));
    expect(top + height).toBeLessThanOrEqual(Math.ceil(9376 * scale));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  test('the whole picture asked for with a stage is still the whole picture', () => {
    // What a reader zoomed all the way out asks for, and it must not come back as a window: the
    // overview is the one picture worth caching, and a rectangle equal to its level is that level.
    const at = pictureLevel(PAN, ROW, showing([0, 0, 1, 1], 2200));
    expect(at?.window).toBeUndefined();
  });

  test('the level puts a sample over each of the stage pixels and no more', () => {
    // The ladder's own rung spacing. A 4000px file shown whole on a 1000px stage wants the level
    // whose long edge is nearest above 1250, which is 2000.
    const small: StoredRecipe = FILE;
    const at = pictureLevel(small, { width: 4000, height: 3000 }, showing([0, 0, 1, 1], 1000));
    expect(at?.level).toBe(1);
    expect(1000 * STAGE_SUPERSAMPLE).toBeLessThanOrEqual(4000 >> (at?.level ?? 0));
  });

  test('a named level and rectangle is served as asked, which is what a tile fetch is', () => {
    // What the client asks for once it holds tiles: the level it already has some of, and the
    // rectangle the missing ones span. Served verbatim rather than re-derived, because this side
    // does not know what the client is holding.
    const at = pictureLevel(PAN, ROW, undefined, {
      level: 2,
      rect: [2048, 1024, 2048, 1024],
      tiles: [
        [2048, 1024, TILE, TILE],
        [3072, 1024, TILE, TILE],
      ],
    });
    expect(at?.level).toBe(2);
    expect(at?.window).toEqual([2048, 1024, 2048, 1024]);
    expect(at?.size.width).toBeGreaterThanOrEqual(2048);
    // And the squares travel with the box, which is what lets the library decode each source for
    // the box bounding its own rather than for the whole of this one.
    expect(at?.parts).toHaveLength(2);
  });

  test('an L of tiles keeps its squares and not just the box they span', () => {
    // **The whole point of sending them.** A diagonal pan is short of an L, whose box holds a
    // corner nobody asked about - and a source that only the corner reaches would be opened and
    // decoded for pixels the client is going to throw away.
    const corner: [number, number, number, number] = [TILE, TILE, TILE, TILE];
    const at = pictureLevel(PAN, ROW, undefined, {
      level: 2,
      rect: [0, 0, TILE * 2, TILE * 2],
      tiles: [
        [0, 0, TILE, TILE],
        [TILE, 0, TILE, TILE],
        [0, TILE, TILE, TILE],
      ],
    });
    expect(at?.window).toEqual([0, 0, TILE * 2, TILE * 2]);
    expect(at?.parts).toHaveLength(3);
    expect(at?.parts).not.toContainEqual(corner);
  });

  test('a square past the level it names is dropped rather than asked for', () => {
    const level = levelSize(ROW.width, ROW.height, 2);
    const at = pictureLevel(PAN, ROW, undefined, {
      level: 2,
      rect: [0, 0, TILE, TILE],
      tiles: [
        [0, 0, TILE, TILE],
        // Off the right-hand edge, which the library would refuse by name.
        [level.width, 0, TILE, TILE],
      ],
    });
    expect(at?.parts).toEqual([[0, 0, TILE, TILE]]);
  });

  test('a named rectangle is clipped to its level rather than trusted', () => {
    // The client names the level it holds, so the rectangle has to be checked against that level's
    // own shape - a tile column past the right-hand edge would otherwise be a window off the end
    // of the picture, which the library refuses by name and the reader sees as an error.
    const level = levelSize(ROW.width, ROW.height, 2);
    const at = pictureLevel(PAN, ROW, undefined, {
      level: 2,
      rect: [level.width - TILE, level.height - 16, TILE * 4, TILE * 4],
      tiles: [],
    });
    const [left = 0, top = 0, width = 0, height = 0] = at?.window ?? [];
    expect(left + width).toBeLessThanOrEqual(level.width);
    expect(top + height).toBeLessThanOrEqual(level.height);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  test('a rectangle at an odd column keeps its far edge, which the even column moved', () => {
    // A window's left edge is floored to an even column, so a span measured from where the client
    // asked ends short of what it asked for - and the tile at that edge is stored with a column of
    // it black, which nothing refetches because the client believes it holds the square.
    const at = pictureLevel(PAN, ROW, undefined, {
      level: 2,
      rect: [2049, 1025, TILE, TILE],
      tiles: [],
    });
    const [left = 0, top = 0, width = 0, height = 0] = at?.window ?? [];
    expect(left).toBe(2048);
    expect(left + width).toBeGreaterThanOrEqual(2049 + TILE);
    expect(top + height).toBeGreaterThanOrEqual(1025 + TILE);
  });

  test('a named level outside the ladder is clamped to it', () => {
    const deepest = pictureLevel(PAN, ROW, undefined, { level: 99, rect: [0, 0, TILE, TILE], tiles: [] });
    expect(deepest?.level).toBe(coarsestLevel(Math.max(ROW.width, ROW.height)));
    const finest = pictureLevel(PAN, ROW, undefined, { level: -3, rect: [0, 0, TILE, TILE], tiles: [] });
    expect(finest?.level).toBe(0);
  });

  test('the missing tiles win over a region, since only the client knows what it holds', () => {
    const both = pictureLevel(PAN, ROW, showing([0, 0, 1, 1], 1600), {
      level: 1,
      rect: [0, 0, TILE, TILE],
      tiles: [],
    });
    expect(both?.level).toBe(1);
    expect(both?.window).toEqual([0, 0, TILE, TILE]);
  });

  test('nothing is prepared for a row with no dimensions', () => {
    expect(pictureLevel(FILE, { width: 0, height: 0 })).toBeNull();
    expect(pictureLevel(FILE, { width: 0, height: 0 }, showing([0, 0, 1, 1], 900))).toBeNull();
  });

  test('a picture already inside the ceiling is served at level zero', () => {
    const at = pictureLevel(FILE, { width: COARSEST_LONG, height: COARSEST_LONG });
    expect(at?.level).toBe(0);
    expect(at?.window).toBeUndefined();
  });
});

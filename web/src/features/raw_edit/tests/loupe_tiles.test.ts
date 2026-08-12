import { describe, expect, test } from 'bun:test';
import { LoupeTiles, covers, tileFor } from '../loupe_tiles';

const FRAME = { width: 6000, height: 4000 };

describe('which tile the loupe asks for', () => {
  test('covers more than the glass, so a small move needs no fetch', () => {
    const tile = tileFor({ x: 3000, y: 2000 }, 400, FRAME);
    expect(tile.width).toBeGreaterThan(400);
    expect(tile.width).toBe(tile.height);
  });

  test('keeps covering the glass through a small move, so no fetch is needed', () => {
    const held = tileFor({ x: 3000, y: 2000 }, 400, FRAME);
    // The tile is centred on where the pointer was, so the slack is the whole margin and it is
    // the same in every direction: a 400px glass on a 600px tile has 100 either way.
    expect(covers(held, { x: 3020, y: 2010 }, 400, FRAME)).toBe(true);
    expect(covers(held, { x: 3095, y: 1905 }, 400, FRAME)).toBe(true);
    expect(covers(held, { x: 2905, y: 2095 }, 400, FRAME)).toBe(true);
  });

  test('stops covering it once the pointer has spent the margin', () => {
    const held = tileFor({ x: 3000, y: 2000 }, 400, FRAME);
    expect(covers(held, { x: 3400, y: 2000 }, 400, FRAME)).toBe(false);
    // And what it asks for then is a rectangle that does cover it.
    const next = tileFor({ x: 3400, y: 2000 }, 400, FRAME);
    expect(covers(next, { x: 3400, y: 2000 }, 400, FRAME)).toBe(true);
  });

  test('always asks for a rectangle that covers where it was asked about', () => {
    // The corners included, where the glass hangs off the photograph and only the part of it
    // that is on the picture can be covered by anything.
    for (const centre of [
      { x: 3000, y: 2000 },
      { x: 200, y: 200 },
      { x: 5900, y: 3900 },
      { x: 0, y: 0 },
    ]) {
      expect(covers(tileFor(centre, 400, FRAME), centre, 400, FRAME)).toBe(true);
    }
  });

  test('stays inside the photograph at every corner', () => {
    for (const centre of [
      { x: 0, y: 0 },
      { x: FRAME.width, y: FRAME.height },
      { x: -500, y: 2000 },
    ]) {
      const tile = tileFor(centre, 400, FRAME);
      expect(tile.left).toBeGreaterThanOrEqual(0);
      expect(tile.top).toBeGreaterThanOrEqual(0);
      expect(tile.left + tile.width).toBeLessThanOrEqual(FRAME.width);
      expect(tile.top + tile.height).toBeLessThanOrEqual(FRAME.height);
    }
  });

  test('a deeper magnification asks for fewer pixels', () => {
    // The span is the loupe's side divided by the magnification, so 4x asks for a quarter of
    // what 1x does - which is the whole reason a tile is worth fetching at all.
    expect(tileFor({ x: 3000, y: 2000 }, 100, FRAME).width).toBeLessThan(
      tileFor({ x: 3000, y: 2000 }, 400, FRAME).width,
    );
  });
});

describe('the tiles held', () => {
  /** A fetch that never settles, so nothing arrives unless a test lets it. */
  function pending(): { tiles: LoupeTiles; asked: string[] } {
    const asked: string[] = [];
    const tiles = new LoupeTiles(
      'photo',
      async (_photo, rect) => {
        asked.push(`${rect.left},${rect.top}`);
        return new Promise<Blob>(() => {});
      },
      () => {},
    );
    return { tiles, asked };
  }

  test('asks once for a tile already in flight', () => {
    const { tiles, asked } = pending();
    const rect = tileFor({ x: 3000, y: 2000 }, 400, FRAME);
    tiles.want(rect);
    tiles.want(rect);
    expect(asked).toHaveLength(1);
  });

  test('asks again for the same tile once the edits have moved', () => {
    const { tiles, asked } = pending();
    const rect = tileFor({ x: 3000, y: 2000 }, 400, FRAME);
    tiles.want(rect);
    // A slider moved, so every tile describes a photograph nobody is looking at.
    tiles.invalidate('rev-2');
    tiles.want(rect);
    expect(asked).toHaveLength(2);
  });

  test('has nothing before anything arrives, which is what the fallback is for', () => {
    const { tiles } = pending();
    const centre = { x: 3000, y: 2000 };
    tiles.want(tileFor(centre, 400, FRAME));
    expect(tiles.covering(centre, 400, FRAME)).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import type { PrintLayout } from '../../../../../src/schemas/print_layout';
import { pictureOn } from '../print_preview';

const page = { widthPx: 1000, heightPx: 1500 };

describe('pictureOn', () => {
  test('an upright photo fitted to its place covers it exactly', () => {
    const layout: PrintLayout = {
      page,
      place: { x: 100, y: 200, width: 800, height: 600 },
      quarterTurns: 0,
    };
    expect(pictureOn(layout, { width: 4000, height: 3000 })).toEqual({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
      turn: 0,
    });
  });

  test('a turned photo is laid out unturned about the place centre, covering it once turned', () => {
    const layout: PrintLayout = {
      page,
      place: { x: 100, y: 100, width: 800, height: 1200 },
      quarterTurns: 1,
    };
    expect(pictureOn(layout, { width: 6000, height: 4000 })).toEqual({
      x: -100,
      y: 300,
      width: 1200,
      height: 800,
      turn: 90,
    });
  });

  test('filling a place of another shape overhangs it on the long side, centred', () => {
    const layout: PrintLayout = {
      page,
      place: { x: 0, y: 0, width: 1000, height: 1000 },
      quarterTurns: 0,
    };
    expect(pictureOn(layout, { width: 2000, height: 1000 })).toEqual({
      x: -500,
      y: 0,
      width: 2000,
      height: 1000,
      turn: 0,
    });
  });
});

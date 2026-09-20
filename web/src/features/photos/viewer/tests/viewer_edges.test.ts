import { describe, expect, test } from 'bun:test';
import { panelEdge, stripEdge } from '../viewer_edges';

const LANDSCAPE = 3 / 2;
const PORTRAIT = 2 / 3;
const PANORAMA = 4;
const THICKNESS = 104;
const STRIP_BELOW = { edge: 'below', thickness: THICKNESS } as const;
const STRIP_BESIDE = { edge: 'beside', thickness: THICKNESS } as const;

describe('panelEdge', () => {
  // The case that made this a measurement rather than a test on the photo's own
  // shape: a 3:2 frame on a 16:9 screen is bound by the height, so the column of
  // width it does not use is exactly where the panels belong.
  test('a landscape frame on a 16:9 screen puts the panels beside it', () => {
    expect(panelEdge(LANDSCAPE, 1880, 950, null)).toBe('beside');
  });

  test('the same frame in a portrait window puts them below it', () => {
    expect(panelEdge(LANDSCAPE, 800, 1200, null)).toBe('below');
  });

  test('a portrait frame keeps them beside it', () => {
    expect(panelEdge(PORTRAIT, 1880, 950, null)).toBe('beside');
  });

  // Wide enough that the width is what binds it, so taking any of it away costs
  // more than the fold does.
  test('a panorama takes the fold', () => {
    expect(panelEdge(PANORAMA, 1880, 950, null)).toBe('below');
  });

  test('an unmeasured box answers beside rather than dividing by nothing', () => {
    expect(panelEdge(LANDSCAPE, 0, 0, null)).toBe('beside');
  });

  // The strip is around the panels on the page, so its slice is gone before they
  // choose - and a strip down the side is what takes the width their column wanted.
  test('an open strip can push the panels off the edge they would have taken', () => {
    expect(panelEdge(LANDSCAPE, 1300, 950, null)).toBe('beside');
    expect(panelEdge(LANDSCAPE, 1300, 950, STRIP_BESIDE)).toBe('below');
  });

  // The same frame, the same strip, on the other edge: what it took was height,
  // and the panels' column is paid for in width.
  test('a strip along the foot leaves the panels where they were', () => {
    expect(panelEdge(LANDSCAPE, 1300, 950, STRIP_BELOW)).toBe('beside');
  });
});

describe('stripEdge', () => {
  // What sent this to its own call: a near-square frame where the panels' 34vh
  // fold costs more than the width their column would take, and a strip a tenth
  // of that height costs far less than either.
  test('a strip takes the foot where the panels would not', () => {
    expect(panelEdge(LANDSCAPE, 1630, 1290, null)).toBe('beside');
    expect(stripEdge(LANDSCAPE, 1630, 1290, THICKNESS)).toBe('below');
  });

  test('a portrait frame with width to spare gives the strip the side', () => {
    expect(stripEdge(PORTRAIT, 1880, 950, THICKNESS)).toBe('beside');
  });

  // A pixel of height is worth `aspect` pixels of width to a landscape frame, so
  // a strip thick enough is cheaper down the side than along the foot.
  test('thickness is what the trade is made on', () => {
    expect(stripEdge(LANDSCAPE, 1400, 1000, 64)).toBe('below');
    expect(stripEdge(LANDSCAPE, 1400, 1000, 260)).toBe('beside');
  });
});

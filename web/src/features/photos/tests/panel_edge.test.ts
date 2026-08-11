import { describe, expect, test } from 'bun:test';
import { panelEdge } from '../panel_edge';

const LANDSCAPE = 3 / 2;
const PORTRAIT = 2 / 3;
const PANORAMA = 4;

describe('panelEdge', () => {
  // The case that made this a measurement rather than a test on the photo's own
  // shape: a 3:2 frame on a 16:9 screen is bound by the height, so the column of
  // width it does not use is exactly where the panels belong.
  test('a landscape frame on a 16:9 screen puts the panels beside it', () => {
    expect(panelEdge(LANDSCAPE, 1880, 950)).toBe('beside');
  });

  test('the same frame in a portrait window puts them below it', () => {
    expect(panelEdge(LANDSCAPE, 800, 1200)).toBe('below');
  });

  test('a portrait frame keeps them beside it', () => {
    expect(panelEdge(PORTRAIT, 1880, 950)).toBe('beside');
  });

  // Wide enough that the width is what binds it, so taking any of it away costs
  // more than the strip does.
  test('a panorama takes the strip', () => {
    expect(panelEdge(PANORAMA, 1880, 950)).toBe('below');
  });

  test('an unmeasured box answers beside rather than dividing by nothing', () => {
    expect(panelEdge(LANDSCAPE, 0, 0)).toBe('beside');
  });
});

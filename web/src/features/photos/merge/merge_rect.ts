// A seeded tile's rectangle, in the recipe's own canvas pixels, and where a piece's frame is read.

import type { Warp } from '../../../../../src/schemas/assembly';

export interface Point {
  x: number;
  y: number;
}

/** `x0 <= x1` and `y0 <= y1`. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A seed's side, as a share of the canvas's long edge: the least a click takes before it grows. */
export const SEED_SHARE = 0.01;

/** The square a click at `point` seeds, kept inside the canvas. */
export function seedAround(point: Point, canvas: readonly [number, number]): Rect {
  const half = (SEED_SHARE * Math.max(canvas[0], canvas[1])) / 2;
  const clamp = (v: number, most: number): number => Math.min(Math.max(v, 0), most);
  return {
    x0: clamp(point.x - half, canvas[0]),
    y0: clamp(point.y - half, canvas[1]),
    x1: clamp(point.x + half, canvas[0]),
    y1: clamp(point.y + half, canvas[1]),
  };
}

/** The corners in the order a seeded tile's vertices are written. */
export function cornersOf(rect: Rect): [number, number][] {
  return [
    [rect.x0, rect.y0],
    [rect.x1, rect.y0],
    [rect.x1, rect.y1],
    [rect.x0, rect.y1],
  ];
}

/** Where a layer is read for a pixel, relative to that pixel, in the layer's pixels. */
export type Shift = readonly [number, number];

export const NO_SHIFT: Shift = [0, 0];

/**
 * A piece's warp as the shift the stage draws it with, in the layer's pixels: `scale` layer pixels
 * a canvas pixel. The stage moves a layer and cannot shear one.
 */
export function shiftOf(warp: Warp, sx: number, sy: number): Shift {
  return [warp[4] * sx, warp[5] * sy];
}

export function boundsOf(loop: readonly (readonly [number, number])[]): Rect {
  const xs = loop.map(([x]) => x);
  const ys = loop.map(([, y]) => y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

import type { MaskStep } from './merge_mask';
import type { Shift } from './merge_rect';

/** One drawn layer: a source index, and the outlines it takes and is covered by, in painter's order. */
export interface DrawnLayer {
  source: number;
  mask: readonly MaskStep[];
  /** How far the mask's edge ramps rather than stepping, in canvas pixels. */
  feather: number;
  /** Where the source is read for a canvas pixel, relative to that pixel, in canvas pixels. */
  shift: Shift;
  /** What the source's light is multiplied by. */
  gain: number;
}

/** What the canvas shows: the base everywhere, then each layer over it. */
export interface Drawing {
  base: number;
  layers: DrawnLayer[];
}

/** One piece of the picture as the render draws it, in the layer's pixels. */
export interface Piece {
  source: number;
  loop: [number, number][];
  shift: Shift;
  gain: number;
  /** As `Seams.corridor`: a share of the long edge. */
  corridor: number;
}

/** The least ramp a mask gets, in canvas pixels: twice `assembly_weight::W_HIGH_PX`, the least `W`. */
export const FEATHER_FLOOR_PX = 4;

/**
 * `pieces`, in the render's order - the last over a pixel takes it - as one layer a source, shift
 * and gain, those being what the stage can draw a layer under.
 *
 * §5.2's `W` is half a piece's corridor capped at `feather`, both shares of the `long` edge, and a
 * mask's feather is the whole ramp: twice `W`, at the narrowest of the layer's pieces.
 */
export function layersOf(pieces: readonly Piece[], base: number, long: number, feather: number): DrawnLayer[] {
  const layers: DrawnLayer[] = [];
  const same = (a: Piece, b: { source: number; shift: Shift; gain: number }): boolean =>
    a.source === b.source && a.shift[0] === b.shift[0] && a.shift[1] === b.shift[1] && a.gain === b.gain;
  const featherOf = (taken: Piece[]): number =>
    Math.max(FEATHER_FLOOR_PX, long * Math.min(2 * feather, ...taken.map((p) => p.corridor)));
  for (const [at, piece] of pieces.entries()) {
    if (piece.source === base || layers.some((layer) => same(piece, layer))) continue;
    const above = pieces.slice(at);
    layers.push({
      source: piece.source,
      mask: above.map((other) => ({ loop: other.loop, taken: same(other, piece) })),
      feather: featherOf(above.filter((other) => same(other, piece))),
      shift: piece.shift,
      gain: piece.gain,
    });
  }
  return layers;
}

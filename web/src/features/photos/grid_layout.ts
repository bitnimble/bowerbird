// Geometry for the virtual grid: which photos are on screen, how tall the
// scroll is, and where the rendered window sits inside it. Pure arithmetic over
// numbers the store already holds, so nothing measures the DOM to decide what to
// render (§18.3.2).

// .grid { gap: 3px }
export const GRID_GAP = 3;

// The height .grid--list fixes every row to. A list row that could grow with its
// contents would make the scroll's height a measurement rather than a sum.
export const LIST_ROW_H = 62;

// .grid--grid gives every photo the same 3:2 cell.
export const TILE_ASPECT = 3 / 2;

// The breathing room inside a band's outline, so its members do not sit on it.
export const BAND_PAD = 6;

// How many photos one list request covers, and the unit rows are cached and
// evicted by. A hundred is a screenful at any zoom, so a scroll never waits on
// more than one request, and it is small enough that dropping one costs little.
export const BLOCK = 100;

// The tallest scroll a browser will honour, less a wide margin. Chromium clamps
// at 33,554,428px and Firefox at roughly half that, silently: past the clamp the
// rest of the collection is simply unreachable, and the grid at its highest zoom
// hits it at thirty thousand photos - one column of thousand-pixel rows. Beyond
// this the scroll is compressed and positions are scaled into it (`scrollScale`)
// rather than the collection being quietly truncated.
export const MAX_SCROLL = 15_000_000;

import type { Span } from '../../ui/virtual_rows';

// Mirrors `repeat(auto-fill, minmax(tile, 1fr))`. The grid is told the count
// through `--cols` rather than working it out itself: a number the two could
// disagree on would put every row at the wrong height, and the error compounds
// over ten thousand rows.
export function gridColumns(width: number, tileSize: number): number {
  if (width <= 0 || tileSize <= 0) return 1;
  return Math.max(1, Math.floor((width + GRID_GAP) / (tileSize + GRID_GAP)));
}

/** Row pitch: the cell's own height plus the gap beneath it. */
export function gridRowHeight(width: number, columns: number): number {
  if (width <= 0) return LIST_ROW_H + GRID_GAP;
  return (width - GRID_GAP * (columns - 1)) / columns / TILE_ASPECT + GRID_GAP;
}

/**
 * Cell height for the rows inside a band, which are shorter than the grid's.
 *
 * A band occupies exactly the display rows the row arithmetic gave it, so the
 * padding inside its outline has to come out of its own cells rather than out of
 * the collection below it - which is what pushed the last row of members through
 * the bottom of the band.
 */
export function bandRowHeight(rows: number, rowHeight: number): number {
  if (rows <= 0) return 0;
  return Math.max(1, (rows * rowHeight - (rows - 1) * GRID_GAP - 2 * BAND_PAD) / rows);
}

// Where each masonry block starts, plus where the last one ends. Masonry packs
// lines from each photo's own shape, so a block's height is only known once it
// has been laid out; the rest are estimated. That estimate is what lets the
// scrollbar describe a collection the client has never held all of.
export function blockTops(count: number, heights: ReadonlyMap<number, number>, estimate: number): number[] {
  const tops = [0];
  for (let block = 0; block < count; block++) tops.push(tops[block]! + (heights.get(block) ?? estimate) + GRID_GAP);
  return tops;
}

// ponytail: linear from the top rather than a binary search. A hundred thousand
// photos is a thousand blocks, walked at most once per scroll frame; bisect if a
// library ever makes that show up in a profile.
export function visibleBlocks(tops: readonly number[], scrollTop: number, viewportHeight: number): Span {
  const count = Math.max(0, tops.length - 1);
  if (count === 0) return { from: 0, to: 0 };
  let from = 0;
  while (from + 1 < count && tops[from + 1]! <= scrollTop) from++;
  let to = from;
  while (to < count && tops[to]! < scrollTop + viewportHeight) to++;
  return { from, to: Math.max(from + 1, to) };
}

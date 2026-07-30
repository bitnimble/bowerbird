// Geometry for the virtual grid: which photos are on screen, how tall the
// scroll is, and where the rendered window sits inside it. Pure arithmetic over
// numbers the store already holds, so nothing measures the DOM to decide what to
// render (§18.3.2).

// Mirrors `--grid-gap`, which .grid's own gap comes from.
export const GRID_GAP = 3;

// The height .grid--list fixes every row to. A list row that could grow with its
// contents would make the scroll's height a measurement rather than a sum.
export const LIST_ROW_H = 62;

// .grid--grid gives every photo the same 3:2 cell.
export const TILE_ASPECT = 3 / 2;

// The breathing room inside a band's outline, so its members do not sit on it.
//
// Half the gap, top and bottom, because that is the whole budget: the row model
// gives a band `rows * rowHeight`, its cells and the gaps between them take
// `rows * (rowHeight - GRID_GAP) + (rows - 1) * GRID_GAP`, and what is left over is
// one gap. Spending more meant taking it off the cells, which drew the same
// photograph at two shapes (§19.6). Mirrored by `.grid__band`'s padding.
export const BAND_PAD = GRID_GAP / 2;

// How many photos one list request covers, and the unit rows are cached and
// evicted by. A hundred is a screenful at any zoom, so a scroll never waits on
// more than one request, and it is small enough that dropping one costs little.
export const BLOCK = 100;

// How tall the scroller itself is, whatever the collection behind it (§18.3.2).
//
// Large enough that recentring is rare: the rail is only put back to its middle
// once the reader is near an end of it (`atRailWall`), and that write cancels an
// in-flight fling on macOS - so the distance between the walls is what buys the
// smooth scroll. A hundred-odd viewports at a typical window height, sixty at a
// very tall one.
export const RAIL_HEIGHT = 100_000;

// How close to an end of the rail the reader gets before it is recentred under
// them, as a multiple of the viewport. Wide enough that the overscan is never
// asked for rows outside the rail.
const RAIL_MARGIN_VIEWPORTS = 2;

import type { Span } from '../../ui/virtual_rows';

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/** How tall the scroller is: the whole collection, until that exceeds the rail. */
export function railHeight(contentHeight: number): number {
  return clamp(contentHeight, RAIL_HEIGHT);
}

// How far the rail's origin can travel down the collection. Zero for a
// collection shorter than the rail, which is what makes those a plain native
// scroll with none of this machinery engaged.
export function anchorLimit(contentHeight: number): number {
  return Math.max(0, contentHeight - railHeight(contentHeight));
}

// Whether the reader has come close enough to an end of the rail that it has to
// be moved under them. A rail that *is* the collection has no walls: its ends
// are the collection's ends, and the reader is meant to reach them.
export function atRailWall(railTop: number, contentHeight: number, viewportHeight: number): boolean {
  if (anchorLimit(contentHeight) === 0) return false;
  const margin = viewportHeight * RAIL_MARGIN_VIEWPORTS;
  return railTop < margin || railTop > railHeight(contentHeight) - viewportHeight - margin;
}

/**
 * The rail put back to its middle, with the anchor moved by exactly as much.
 *
 * `anchorTop + railTop` is where the reader is in the collection, and it is the
 * same before and after: the rail moves and nothing on screen does.
 */
export function recentred(
  anchorTop: number,
  railTop: number,
  contentHeight: number,
  viewportHeight: number,
): { anchorTop: number; railTop: number } {
  const middle = Math.max(0, (railHeight(contentHeight) - viewportHeight) / 2);
  const moved = clamp(anchorTop + railTop - middle, anchorLimit(contentHeight)) - anchorTop;
  return { anchorTop: anchorTop + moved, railTop: railTop - moved };
}

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
 * Cell height for the rows inside a band, which is **the grid's own**.
 *
 * A member is the same photograph as any other row of the collection and is drawn
 * at the same size: it was a fraction shorter for a while, to pay for the band's
 * padding out of its own cells, and that was enough to letterbox a frame that
 * filled its cell in the grid. A band occupies exactly the display rows the row
 * arithmetic gave it either way; what pays for the padding is the one gap those
 * rows have spare (`BAND_PAD`).
 */
export function bandRowHeight(rows: number, rowHeight: number): number {
  if (rows <= 0) return 0;
  return Math.max(1, rowHeight - GRID_GAP);
}

/**
 * Which tiles begin a line of masonry, from the shapes alone.
 *
 * The wrap replayed rather than measured: a tile's hypothetical width is its flex
 * basis, `--ar * --tile`, and a line takes tiles until the next one no longer
 * fits. Bands are not in it because a band is a full-width item and so never
 * shares a line - it sits between one line and the next, and the tiles either
 * side pack exactly as they would without it.
 *
 * What it buys is where a band goes: at the end of the line its stack's tile sits
 * on rather than directly after that tile, which cut the line short and handed
 * its free space to the tiles left on it - a stack opened at the start of a line
 * was stretched across the whole grid, and its neighbours pushed below the band.
 */
export function masonryLineStarts(ratios: readonly number[], width: number, tileSize: number): Set<number> {
  const starts = new Set<number>();
  let line = 0;
  for (let i = 0; i < ratios.length; i++) {
    const basis = Math.max(1, ratios[i]! * tileSize);
    if (line > 0 && line + GRID_GAP + basis > width) line = 0;
    if (line === 0) starts.add(i);
    line += (line > 0 ? GRID_GAP : 0) + basis;
  }
  return starts;
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

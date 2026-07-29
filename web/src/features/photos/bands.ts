// Row arithmetic for expanded stacks (DESIGN §19.6).
//
// Opening a stack inserts a band of fresh rows directly below the row its tile
// sits in. The members live alone in that band and never share a row with photos
// from outside the stack, so no tile ever changes which neighbours it sits
// beside: the grid below is displaced downwards and otherwise untouched.
//
// Every row stays the same height, which is what keeps the scroll a
// multiplication rather than a measurement. `visibleRows` takes one row height
// for the whole list, so a band that wanted its own would put the scroll height
// back into the DOM - which is the thing the virtual grid exists to avoid.

/** An open stack: where its tile sits in the collection, and how many it holds. */
export interface Band {
  /** Position of the stack's row in the collapsed collection. */
  position: number;
  /** How many member tiles the band shows. */
  members: number;
}

/** A display row is either a row of the collection or a row inside one band. */
export type BandRow =
  | { kind: 'grid'; row: number }
  | { kind: 'band'; band: Band; offset: number };

export function bandRows(members: number, columns: number): number {
  return Math.max(0, Math.ceil(members / Math.max(1, columns)));
}

/** The row of the collection a band hangs beneath. */
function anchorRow(band: Band, columns: number): number {
  return Math.floor(band.position / Math.max(1, columns));
}

/**
 * Bands in the order they appear, which is the order every walk here assumes.
 *
 * Sorted by the row they hang under rather than by position, because two stacks
 * open on the same row produce two bands beneath it and their order has to be
 * settled somehow; left to right is what the eye expects.
 */
export function ordered(bands: readonly Band[], columns: number): Band[] {
  return [...bands].sort((a, b) => anchorRow(a, columns) - anchorRow(b, columns) || a.position - b.position);
}

export function totalRows(baseRows: number, bands: readonly Band[], columns: number): number {
  let rows = baseRows;
  for (const band of bands) rows += bandRows(band.members, columns);
  return rows;
}

// ponytail: a linear walk per lookup rather than a prefix-sum index. Bands are
// the stacks a reader has open at once, so this is a handful of entries; build
// the index if somebody ever opens hundreds.
function walk(bands: readonly Band[], columns: number): { band: Band; startsAt: number; rows: number }[] {
  const placed: { band: Band; startsAt: number; rows: number }[] = [];
  let inserted = 0;
  for (const band of ordered(bands, columns)) {
    // +1 because the band begins on the row *after* the one its tile sits in,
    // and `inserted` carries the rows every earlier band already pushed down.
    const startsAt = anchorRow(band, columns) + 1 + inserted;
    const rows = bandRows(band.members, columns);
    placed.push({ band, startsAt, rows });
    inserted += rows;
  }
  return placed;
}

/** What a display row shows. */
export function rowAt(displayRow: number, bands: readonly Band[], columns: number): BandRow {
  let shift = 0;
  for (const { band, startsAt, rows } of walk(bands, columns)) {
    if (displayRow < startsAt) break;
    if (displayRow < startsAt + rows) return { kind: 'band', band, offset: displayRow - startsAt };
    shift += rows;
  }
  return { kind: 'grid', row: displayRow - shift };
}

/** Where a row of the collection ends up on screen once the bands are in. */
export function displayRowOf(gridRow: number, bands: readonly Band[], columns: number): number {
  let shift = 0;
  for (const { band, rows } of walk(bands, columns)) {
    if (anchorRow(band, columns) < gridRow) shift += rows;
  }
  return gridRow + shift;
}

/**
 * How far the content below a band moves when it opens, in rows.
 *
 * What the scroll correction is computed from: opening a stack above the
 * viewport displaces everything below it, so the action adds this many rows'
 * worth of pixels to `scrollTop` and the view does not move (§19.6.1).
 */
export function rowsInsertedAbove(position: number, bands: readonly Band[], columns: number): number {
  let rows = 0;
  for (const band of bands) {
    if (anchorRow(band, columns) <= Math.floor(position / Math.max(1, columns))) rows += bandRows(band.members, columns);
  }
  return rows;
}

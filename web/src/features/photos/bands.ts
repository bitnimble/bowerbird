// Row arithmetic for expanded stacks (DESIGN §19.6).
//
// Opening a stack inserts a band of fresh rows directly below the row its tile
// sits in. The members live alone in that band and never share a row with photos
// from outside the stack, so no tile ever changes which neighbours it sits
// beside: the grid below is displaced downwards and otherwise untouched.
//
// Every row is the same height, band rows included, which is what lets a member be
// the same size as any other photograph in the collection. What a band adds is its
// own inset (`BAND_EXTRA`) - so the scroll is a multiplication *plus* a count of the
// bands above, and the pair of walks at the bottom of this file is the only place
// that conversion happens. Still arithmetic over numbers the store already holds:
// nothing measures the DOM to decide what to render.

import { BAND_EXTRA, BAND_PAD } from './grid_layout';
import { OVERSCAN_ROWS, type Span } from '../../ui/virtual_rows';

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

/**
 * First row of the unbroken run of collection rows this row belongs to.
 *
 * Bands break the collection into runs, and a run is what the grid renders as one
 * element - so this is the run's name, and the only part of it that does not move
 * when the viewport does.
 */
export function runStart(gridRow: number, bands: readonly Band[], columns: number): number {
  let start = 0;
  for (const band of ordered(bands, columns)) {
    const anchor = anchorRow(band, columns);
    if (anchor < gridRow) start = anchor + 1;
  }
  return start;
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
 * What the correction that holds the reader's place is computed from: opening a
 * stack above the viewport displaces everything below it, so the view moves this
 * many rows' worth of pixels down the collection (§19.6.1).
 */
export function rowsInsertedAbove(position: number, bands: readonly Band[], columns: number): number {
  let rows = 0;
  for (const band of bands) {
    if (anchorRow(band, columns) <= Math.floor(position / Math.max(1, columns))) rows += bandRows(band.members, columns);
  }
  return rows;
}

/**
 * Content pixels from the top of the collection to the top of a display row.
 *
 * Rows are one height throughout; what makes this more than a multiplication is
 * that a band is taller than the rows it covers by its own inset (`BAND_EXTRA`).
 * A row *inside* a band has only the leading half of that above it, and the band's
 * own first row has neither - its box begins where the inset does.
 */
export function topOfRow(displayRow: number, bands: readonly Band[], columns: number, rowHeight: number): number {
  let extra = 0;
  for (const { startsAt, rows } of walk(bands, columns)) {
    if (displayRow <= startsAt) break;
    extra += displayRow < startsAt + rows ? BAND_PAD : BAND_EXTRA;
  }
  return displayRow * rowHeight + extra;
}

/** Which display row a content pixel falls in: `topOfRow` the other way round. */
export function rowAtTop(top: number, bands: readonly Band[], columns: number, rowHeight: number): number {
  if (rowHeight <= 0) return 0;
  let extra = 0;
  for (const { startsAt, rows } of walk(bands, columns)) {
    const bandTop = startsAt * rowHeight + extra;
    if (top < bandTop) break;
    if (top < bandTop + rows * rowHeight + BAND_EXTRA) {
      const into = Math.floor((top - bandTop - BAND_PAD) / rowHeight);
      return startsAt + Math.max(0, Math.min(rows - 1, into));
    }
    extra += BAND_EXTRA;
  }
  return Math.floor((top - extra) / rowHeight);
}

/**
 * Which display rows are on screen, plus the overscan either side.
 *
 * `visibleRows` answers this for a list whose rows are all the same height; a
 * collection with a band open has one pitch and a handful of insets, so it needs
 * the walk above rather than a division.
 */
export function visibleBandRows(
  top: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  bands: readonly Band[],
  columns: number,
): Span {
  if (rowCount <= 0 || rowHeight <= 0) return { from: 0, to: 0 };
  // Clamped at the top as well as the bottom, for the reason `visibleRows` is: the
  // scroll position is sampled a frame behind the content height, so a collection
  // that just shrank leaves it pointing past the end of the one it now describes.
  const last = rowCount - 1;
  const from = Math.min(last, Math.max(0, rowAtTop(top, bands, columns, rowHeight) - OVERSCAN_ROWS));
  const to = Math.min(rowCount, rowAtTop(top + viewportHeight, bands, columns, rowHeight) + 1 + OVERSCAN_ROWS);
  return { from, to: Math.max(from + 1, to) };
}

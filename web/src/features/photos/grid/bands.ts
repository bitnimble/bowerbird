// Row arithmetic for expanded stacks (DESIGN §19.6).
//
// Opening a stack inserts a band of fresh rows directly below the row its tile
// sits in. The members live alone in that band and never share a row with photos
// from outside the stack, so no tile ever changes which neighbours it sits
// beside: the grid below is displaced downwards and otherwise untouched.
//
// Every row is the same height, band rows included, which is what lets a member be
// the same size as any other photograph in the collection and keeps the scroll a
// multiplication rather than a measurement. A band is inset from its outline by
// nothing at all - its members hold their own inset (`TILE_PAD`), so its ring lands
// on no photograph - so it is exactly the rows it covers, and `visibleRows` can take
// one row height for the whole collection.
//
// Every function here takes the column count, so the same arithmetic lays out the
// gallery and the viewer's filmstrip - which is one row, and so `columns` of 1,
// with a band's members inserted into the run after the stack they belong to.

import { type CompositeKind, type PhotoSummary } from '../../../../../src/schemas/photos';
import type { Span } from '../../../ui/virtual_rows';

/** A stack the reader has opened, and the members it is showing. */
export interface Expansion {
  stackId: string;
  /** Set where these are a composite's frames rather than a stack's members, which they are announced as. */
  composite?: CompositeKind | null;
  /** Where the stack's own tile sits in the collapsed collection. */
  position: number;
  photos: PhotoSummary[];
  /**
   * Whether this band survives its row ceasing to stand for a stack, which is the
   * reader having opened it from exactly that row. Absent is the ordinary
   * lifecycle, where the band closes with the stack tile it hangs off (§19.6.1).
   */
  keepOpen?: boolean;
}

/**
 * A run of display rows showing one kind of thing.
 *
 * `key` names the run rather than the window over it, so scrolling re-positions
 * the element React already has instead of replacing it: a new key unmounts every
 * tile in the run, which throws away each one's decoded image and re-requests it.
 */
export type GridSection =
  | { kind: 'grid'; key: string; top: number; from: number; to: number }
  | { kind: 'band'; key: string; top: number; stackId: string; composite?: CompositeKind | null; position: number; photos: PhotoSummary[] };

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
 * What each display row in `span` shows: rows of the collection, or the members
 * of one open stack.
 *
 * Consecutive rows of a kind are one section, so a band several rows tall is one
 * bordered box rather than one per row.
 *
 * Positions are in content pixels, which the view turns into rail positions
 * (`ScrollRailStore.positionOf`): held against the rail they would all have to be
 * rewritten every time it was recentred.
 */
export function sectionsIn(
  span: Span,
  layout: {
    bands: readonly Band[];
    columns: number;
    total: number;
    /** The pitch of one display row along the scroll axis. */
    rowHeight: number;
    expansionAt: (position: number) => Expansion | null;
  },
): GridSection[] {
  const { bands, columns, total, rowHeight } = layout;
  const sections: GridSection[] = [];
  for (let display = span.from; display < span.to; display++) {
    const at = rowAt(display, bands, columns);
    const last = sections.at(-1);
    if (at.kind === 'grid') {
      const from = at.row * columns;
      const to = Math.min(total, from + columns);
      if (last?.kind === 'grid' && last.to === from) last.to = to;
      else sections.push({ kind: 'grid', key: `grid-${runStart(at.row, bands, columns)}`, top: display * rowHeight, from, to });
      continue;
    }
    const open = layout.expansionAt(at.band.position);
    if (open == null) continue;
    if (last?.kind === 'band' && last.stackId === open.stackId) continue;
    // The band's *own* first row, not whichever of its rows happened to be the
    // first one visible: every member is drawn from this offset, so anchoring it
    // to the visible row would slide the whole band down by however much of it is
    // above the fold and paint it over the grid below.
    sections.push({
      kind: 'band',
      key: `band-${open.stackId}`,
      top: (display - at.offset) * rowHeight,
      stackId: open.stackId,
      composite: open.composite,
      position: open.position,
      photos: open.photos,
    });
  }
  return sections;
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

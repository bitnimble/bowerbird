// Which rows of a uniform-height list are on screen. Pure arithmetic over four
// numbers, so nothing measures the DOM to decide what to render (§18.2).
//
// Lives here rather than with the photo grid because two features now scroll a
// list longer than the DOM should hold: the gallery over a collection (§18.3.2)
// and the Shoots page over a library's folders (§18.3.4). The grid's own
// geometry - tile aspect, column counts, masonry block packing - stays with the
// grid; this is the part that is about rows and nothing else.

/** A half-open range: `from` inclusive, `to` exclusive. */
export interface Span {
  from: number;
  to: number;
}

// Rows rendered either side of the viewport, so a flick lands on rows that are
// already mounted rather than on a gap.
export const OVERSCAN_ROWS = 2;

export function visibleRows(scrollTop: number, viewportHeight: number, rowHeight: number, rowCount: number): Span {
  if (rowCount <= 0 || rowHeight <= 0) return { from: 0, to: 0 };
  // Clamped at the top as well as the bottom: the scroll position is sampled a
  // frame behind the content height, so binning most of a library leaves a
  // scrollTop pointing past the end of the collection it now describes. Read
  // unclamped that produced `from > to`, which renders nothing and asks for no
  // blocks - a grid that has silently given up.
  const last = rowCount - 1;
  const from = Math.min(last, Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS));
  const to = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS);
  return { from, to: Math.max(from + 1, to) };
}

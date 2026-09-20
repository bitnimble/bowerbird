// The grid a repair is written on, and the shape a repair has - without zod, which the page keeps
// out of its bundle (`display_size.ts` is here for the same reason). `photo_edits.ts` parses what
// this describes.

/**
 * `px::STORED_LONG`: steps across a photograph's long edge on the grid a repair is written on, the
 * short edge in proportion. Across the long edge rather than a fraction of each axis, so that a
 * step across and a step down are the same length.
 */
export const STORED_LONG = 65535;

/** The most repairs one photograph holds, and the most vertices either loop of one may have. */
export const MOST_REPAIRS = 64;
export const MOST_REPAIR_VERTICES = 64;

/** A position on the grid: whole steps. */
export type StoredPoint = [number, number];

/** A spot or a thing the reader removed, filled from elsewhere in the same photograph. */
export interface Repair {
  drawn: StoredPoint[];
  seam: StoredPoint[];
  donor: [number, number];
  gain: number;
  feather?: number;
}

/** A photograph's extent on the grid: `px::Size::stored`, rounded the way it rounds. */
export function storedSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height, 1);
  return {
    width: Math.round((width / long) * STORED_LONG),
    height: Math.round((height / long) * STORED_LONG),
  };
}

/**
 * A loop the reader drew, as fractions of the frame, onto the grid: at most `MOST_REPAIR_VERTICES`
 * vertices, simplified until it fits, or null where nothing enclosing is left.
 *
 * Douglas-Peucker in the grid's own steps, loosened until the loop is short enough - a lasso is
 * hundreds of pointer positions, and the document holds a few dozen.
 */
export function storedLoop(
  drawn: readonly { x: number; y: number }[],
  frame: { width: number; height: number },
): StoredPoint[] | null {
  const grid = storedSize(frame.width, frame.height);
  const onGrid = drawn.map(({ x, y }): StoredPoint => [
    Math.round(Math.min(Math.max(x, 0), 1) * grid.width),
    Math.round(Math.min(Math.max(y, 0), 1) * grid.height),
  ]);
  const distinct = onGrid.filter(
    (point, at) => at === 0 || point[0] !== onGrid[at - 1]![0] || point[1] !== onGrid[at - 1]![1],
  );
  if (distinct.length < 3) return null;
  let tolerance = 1;
  let loop = simplified(distinct, tolerance);
  while (loop.length > MOST_REPAIR_VERTICES) {
    tolerance *= 1.5;
    loop = simplified(distinct, tolerance);
  }
  return loop.length >= 3 && Math.abs(area(loop)) > 0 ? loop : null;
}

/** Douglas-Peucker over a closed loop, cut at its first vertex and its farthest from it. */
function simplified(loop: StoredPoint[], tolerance: number): StoredPoint[] {
  const first = loop[0]!;
  let far = 0;
  loop.forEach((point, at) => {
    if (distance(point, first) > distance(loop[far]!, first)) far = at;
  });
  const there = chain(loop.slice(0, far + 1), tolerance);
  const back = chain([...loop.slice(far), first], tolerance);
  return [...there.slice(0, -1), ...back.slice(0, -1)];
}

function chain(points: StoredPoint[], tolerance: number): StoredPoint[] {
  if (points.length < 3) return points;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  let widest = -1;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const off = offSegment(points[i]!, a, b);
    if (off > widest) {
      widest = off;
      at = i;
    }
  }
  if (widest <= tolerance) return [a, b];
  return [...chain(points.slice(0, at + 1), tolerance).slice(0, -1), ...chain(points.slice(at), tolerance)];
}

function distance(a: StoredPoint, b: StoredPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function offSegment(p: StoredPoint, a: StoredPoint, b: StoredPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  if (length === 0) return distance(p, a);
  const t = Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length, 0), 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function area(loop: StoredPoint[]): number {
  let twice = 0;
  loop.forEach((point, at) => {
    const next = loop[(at + 1) % loop.length]!;
    twice += point[0] * next[1] - next[0] * point[1];
  });
  return twice / 2;
}

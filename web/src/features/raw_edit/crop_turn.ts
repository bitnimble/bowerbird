/** A crop rectangle, as fractions of an edge. The document's four fields, or the overlay's. */
export interface CropRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The document's crop as the overlay should lay it out, and back.
 *
 * `EditDocSchema` defines the fractions against the straightened frame **before** the quarter
 * turn - Camera Raw's order, and the one `image::Plan` undoes first - while the overlay sits on
 * the picture *after* it. So the pair has to be permuted, in opposite directions, and the two
 * halves live here rather than one in the store and one in the presenter: they are inverses,
 * which is a property worth being able to test rather than to read twice.
 *
 * Getting a term wrong swaps or mirrors a crop, which still looks like a crop of the same
 * photograph - every edge is a fraction in the same range - so nothing downstream would say so.
 */
export function turnedForDisplay(crop: CropRect, rotate: number): CropRect {
  const { left: l, top: t, right: r, bottom: b } = crop;
  switch (rotate) {
    case 90:
      return { left: 1 - b, top: l, right: 1 - t, bottom: r };
    case 180:
      return { left: 1 - r, top: 1 - b, right: 1 - l, bottom: 1 - t };
    case 270:
      return { left: t, top: 1 - r, right: b, bottom: 1 - l };
    default:
      return { left: l, top: t, right: r, bottom: b };
  }
}

export function turnedForDocument(shown: CropRect, rotate: number): CropRect {
  const { left: l, top: t, right: r, bottom: b } = shown;
  switch (rotate) {
    case 90:
      return { left: t, top: 1 - r, right: b, bottom: 1 - l };
    case 180:
      return { left: 1 - r, top: 1 - b, right: 1 - l, bottom: 1 - t };
    case 270:
      return { left: 1 - b, top: l, right: 1 - t, bottom: r };
    default:
      return { left: l, top: t, right: r, bottom: b };
  }
}

/**
 * A single point through the same turn, for the things that are not rectangles.
 *
 * The keystone guides are lines, and a line's two ends are just points: turning each and
 * letting the line follow is right where turning a rectangle's edges by name would not be.
 */
export function turnedPointForDisplay(point: { x: number; y: number }, rotate: number): { x: number; y: number } {
  switch (rotate) {
    case 90:
      return { x: 1 - point.y, y: point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: point.y, y: 1 - point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

export function turnedPointForDocument(point: { x: number; y: number }, rotate: number): { x: number; y: number } {
  switch (rotate) {
    case 90:
      return { x: point.y, y: 1 - point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: 1 - point.y, y: point.x };
    default:
      return { x: point.x, y: point.y };
  }
}

/** Which edges a grip moves. The corners move two, the sides one, and `null` moves all four. */
export interface CropGrip {
  x: 'left' | 'right' | null;
  y: 'top' | 'bottom' | null;
}

/** The narrowest crop a drag may leave, as a fraction: below this there is nothing to judge. */
export const MINIMUM_CROP = 0.02;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * The rectangle a drag of `by` leaves, from the one it started on.
 *
 * Fractions in and fractions out, so the caller's only job is to say how far the pointer went
 * as a share of the picture. Here rather than in the overlay because it is the rule that keeps
 * a crop a crop - four edges in order, none outside the frame - and a rule inside a component
 * is one nothing can test.
 */
export function draggedCrop(
  start: CropRect,
  grip: CropGrip | null,
  by: { x: number; y: number },
): CropRect {
  if (grip == null) {
    // The whole rectangle, held inside the picture rather than clamped edge by edge - clamping
    // each would let a rectangle dragged into a corner change shape on the way.
    const width = start.right - start.left;
    const height = start.bottom - start.top;
    const left = clamp(start.left + by.x, 0, 1 - width);
    const top = clamp(start.top + by.y, 0, 1 - height);
    return { left, top, right: left + width, bottom: top + height };
  }
  const next = { ...start };
  if (grip.x === 'left') next.left = clamp(start.left + by.x, 0, start.right - MINIMUM_CROP);
  if (grip.x === 'right') next.right = clamp(start.right + by.x, start.left + MINIMUM_CROP, 1);
  if (grip.y === 'top') next.top = clamp(start.top + by.y, 0, start.bottom - MINIMUM_CROP);
  if (grip.y === 'bottom') next.bottom = clamp(start.bottom + by.y, start.top + MINIMUM_CROP, 1);
  return next;
}

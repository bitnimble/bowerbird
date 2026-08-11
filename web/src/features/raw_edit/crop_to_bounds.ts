// The biggest rectangle with no blank in it, after a straighten and a perspective correction.
//
// Both leave the picture sitting inside its frame as a *quadrilateral*: a straighten turns the
// frame inside its own bounding box and leaves four corner wedges, a keystone stretches one end
// and squeezes the other and leaves wedges down whole sides. What is left is convex either way -
// a rectangle through a projective map is a convex quad, and turning one keeps it convex - and
// that is what makes this answerable rather than a search.
//
// For a convex region the largest axis-aligned rectangle has a closed form once its left and
// right edges are chosen. The region's lower boundary is convex and its upper boundary concave,
// so over any interval the highest floor and the lowest ceiling are both at an end of it:
//
//   height(x0, x1) = min(ceiling(x0), ceiling(x1)) - max(floor(x0), floor(x1))
//
// So the whole problem is two numbers, and what is left is to search them - which is cheap, and
// exact to whatever the refinement below is worth.

import type { CropRect } from './crop_turn';
import { keystoneShows, type Keystone } from './keystone';

/** What the picture is sitting in: the frame, the straighten, and the correction. */
export interface Bounds {
  width: number;
  height: number;
  cropAngle: number;
  keystone: Keystone | null;
}

interface Point {
  x: number;
  y: number;
}

/** How finely the two edges are searched, and then re-searched around the best pair. */
const STEPS = 96;
const REFINEMENTS = 4;

/**
 * The picture's four corners, as fractions of the straightened frame.
 *
 * Which is the space the crop is defined in (`EditDocSchema`), so what comes back can be written
 * to the document with no further mapping. The quarter turn is not in it and does not need to
 * be: the fractions are stored before the turn.
 */
export function pictureCorners(bounds: Bounds): Point[] {
  const { width, height, cropAngle, keystone } = bounds;
  const radians = (cropAngle * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const straight = {
    x: width * Math.abs(c) + height * Math.abs(s),
    y: width * Math.abs(s) + height * Math.abs(c),
  };

  const out: Point[] = [];
  for (const corner of [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]) {
    // Where the correction puts this corner of the frame, still in the frame's own fractions.
    const moved = keystone == null ? corner : keystoneShows(keystone, corner.x, corner.y);
    if (moved == null) return [];
    // Into the straightened frame: `Plan::at` reads a straightened point as
    // `full/2 + R(point - straight/2)`, so this is that inverted.
    const fx = moved.x * width - width / 2;
    const fy = moved.y * height - height / 2;
    out.push({
      x: (fx * c - fy * s + straight.x / 2) / straight.x,
      y: (fx * s + fy * c + straight.y / 2) / straight.y,
    });
  }
  return out;
}

/**
 * Where a vertical line crosses the quad, or null where it misses it entirely.
 *
 * Convex, so the line goes in once and out once and the crossings' extremes *are* the span -
 * no winding, no ordering, and a corner counted twice changes nothing.
 */
function span(quad: Point[], x: number): { top: number; bottom: number } | null {
  const crossings: number[] = [];
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    if (x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) continue;
    if (a.x === b.x) {
      crossings.push(a.y, b.y);
      continue;
    }
    crossings.push(a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
  }
  if (crossings.length === 0) return null;
  // Named for the picture rather than the number line: `top` is the smaller y.
  return { top: Math.min(...crossings), bottom: Math.max(...crossings) };
}

/**
 * The largest rectangle inside the picture, as crop fractions, or null where there is nothing
 * to trim.
 *
 * Null for an upright, uncorrected frame - the whole of it is the answer and writing a crop
 * that says so would be a step in the history that changes no pixel.
 */
export function insetCrop(bounds: Bounds): CropRect | null {
  if (bounds.cropAngle === 0 && bounds.keystone == null) return null;
  const quad = pictureCorners(bounds);
  if (quad.length !== 4) return null;

  const first = Math.min(...quad.map((p) => p.x));
  const last = Math.max(...quad.map((p) => p.x));
  // **A window per edge, not one window around both.** Narrowing a single range to
  // `[left - margin, right + margin]` leaves it unchanged whenever the winning pair sits at the
  // ends of it - which is most of them - so every later pass re-searched the same grid and the
  // answer stayed snapped to a 96th of the frame. At a tenth of a degree that threw away 1.8%
  // of a picture whose wedges are seven pixels deep.
  let leftLow = first;
  let leftHigh = last;
  let rightLow = first;
  let rightHigh = last;
  let best: CropRect | null = null;
  let bestArea = 0;

  for (let pass = 0; pass < REFINEMENTS; pass += 1) {
    const leftStep = (leftHigh - leftLow) / STEPS;
    const rightStep = (rightHigh - rightLow) / STEPS;
    if (!(leftStep > 0) && !(rightStep > 0)) break;
    for (let i = 0; i <= STEPS; i += 1) {
      const x0 = leftLow + i * leftStep;
      const at0 = span(quad, x0);
      if (at0 == null) continue;
      for (let j = 0; j <= STEPS; j += 1) {
        const x1 = rightLow + j * rightStep;
        if (x1 <= x0) continue;
        const at1 = span(quad, x1);
        if (at1 == null) continue;
        // Convexity is what makes these two the whole story: over the interval the floor is
        // highest at an end and the ceiling lowest at an end.
        const top = Math.max(at0.top, at1.top);
        const bottom = Math.min(at0.bottom, at1.bottom);
        if (bottom <= top) continue;
        const area = (x1 - x0) * (bottom - top);
        if (area > bestArea) {
          bestArea = area;
          best = { left: x0, top, right: x1, bottom };
        }
      }
    }
    if (best == null) break;
    // Two steps either side of each winner, which is the neighbourhood the grid could have
    // straddled - and always narrower than the range it came from, so the next pass is finer.
    leftLow = Math.max(first, best.left - 2 * leftStep);
    leftHigh = Math.min(last, best.left + 2 * leftStep);
    rightLow = Math.max(first, best.right - 2 * rightStep);
    rightHigh = Math.min(last, best.right + 2 * rightStep);
  }

  if (best == null) return null;
  // Held inside the frame the fractions are of. The search cannot leave it, but a rectangle
  // rounded outwards by a floating point hair would put the wedge back.
  const held = {
    left: Math.max(best.left, 0),
    top: Math.max(best.top, 0),
    right: Math.min(best.right, 1),
    bottom: Math.min(best.bottom, 1),
  };
  return held.right > held.left && held.bottom > held.top ? held : null;
}

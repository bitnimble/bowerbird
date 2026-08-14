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
  /**
   * The rectangle the answer has to stay inside, where the reader chose one.
   *
   * Their crop, so that levelling a horizon trims the wedges out of the picture they framed
   * rather than handing back the frame they had already cropped away. The whole frame when they
   * have chosen nothing, which is the same search as before.
   */
  within?: CropRect;
}

const WHOLE_FRAME: CropRect = { left: 0, top: 0, right: 1, bottom: 1 };

interface Point {
  x: number;
  y: number;
}

/** How finely the two edges are searched, and then re-searched around the best pair. */
const STEPS = 96;
const REFINEMENTS = 4;

/** How finely `centred` bisects, and the share of the area it may trade for the slide. */
const SLIDES = 32;
const GIVEN_UP = 1e-9;

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

interface Crossing {
  x: number;
  top: number;
  bottom: number;
}

/** Where a vertical crosses both the picture and the rectangle the answer is held inside. */
function crossing(quad: Point[], within: CropRect, x: number): Crossing | null {
  if (x < within.left || x > within.right) return null;
  const at = span(quad, x);
  if (at == null) return null;
  const top = Math.max(at.top, within.top);
  const bottom = Math.min(at.bottom, within.bottom);
  return bottom > top ? { x, top, bottom } : null;
}

/** One pass's verticals, crossed once each rather than once per pair the loops below try. */
function verticals(quad: Point[], within: CropRect, from: number, step: number): Crossing[] {
  const out: Crossing[] = [];
  for (let i = 0; i <= STEPS; i += 1) {
    const at = crossing(quad, within, from + i * step);
    if (at != null) out.push(at);
  }
  return out;
}

/**
 * The same rectangle, slid as near the middle of `within` as it can without giving up area.
 *
 * **The largest rectangle is not unique.** Past about 21 degrees on a 3:2 frame a whole family
 * of identical ones slides across the picture, all exactly equal in area, and which of them the
 * grid above reaches moves half the frame for a hundredth of a degree - the crop teleporting
 * under a hand on the straighten slider. Every member re-centres to the same rectangle, so this
 * is what makes the answer a function of the angle rather than of the search.
 *
 * One number, because the pair of edges is the whole of the freedom: the vertical extent is
 * whatever those two verticals leave, which is already as tall as it goes and not a choice. So
 * the family is this slide, and the area over it is concave - a min of concave boundaries less
 * a max of convex ones - which is what makes the members that keep the area an interval, and
 * finding its end a bisection.
 */
function centred(quad: Point[], within: CropRect, rect: CropRect): CropRect {
  const slid = (by: number): CropRect | null => {
    const left = crossing(quad, within, rect.left + by);
    const right = crossing(quad, within, rect.right + by);
    if (left == null || right == null) return null;
    const top = Math.max(left.top, right.top);
    const bottom = Math.min(left.bottom, right.bottom);
    return bottom > top ? { left: left.x, top, right: right.x, bottom } : null;
  };
  const area = (of: CropRect | null): number =>
    of == null ? 0 : (of.right - of.left) * (of.bottom - of.top);

  const keep = area(rect) * (1 - GIVEN_UP);
  const wanted = (within.left + within.right) / 2 - (rect.left + rect.right) / 2;
  const all = slid(wanted);
  if (all != null && area(all) >= keep) return all;

  let low = 0;
  let high = wanted;
  for (let i = 0; i < SLIDES; i += 1) {
    const mid = (low + high) / 2;
    if (area(slid(mid)) >= keep) low = mid;
    else high = mid;
  }
  return slid(low) ?? rect;
}

/**
 * The largest rectangle inside both the picture and `within`, as crop fractions, or null where
 * there is nothing to trim.
 *
 * Null for an upright, uncorrected frame - `within` is already the answer and writing it back
 * would be a step in the history that changes no pixel.
 */
export function insetCrop(bounds: Bounds): CropRect | null {
  if (bounds.cropAngle === 0 && bounds.keystone == null) return null;
  const quad = pictureCorners(bounds);
  if (quad.length !== 4) return null;
  const within = bounds.within ?? WHOLE_FRAME;

  const first = Math.max(Math.min(...quad.map((p) => p.x)), within.left);
  const last = Math.min(Math.max(...quad.map((p) => p.x)), within.right);
  if (last <= first) return null;
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
    const lefts = verticals(quad, within, leftLow, leftStep);
    const rights = verticals(quad, within, rightLow, rightStep);
    for (const at0 of lefts) {
      for (const at1 of rights) {
        if (at1.x <= at0.x) continue;
        // Convexity is what makes these two the whole story: over the interval the floor is
        // highest at an end and the ceiling lowest at an end.
        const top = Math.max(at0.top, at1.top);
        const bottom = Math.min(at0.bottom, at1.bottom);
        if (bottom <= top) continue;
        const area = (at1.x - at0.x) * (bottom - top);
        if (area > bestArea) {
          bestArea = area;
          best = { left: at0.x, top, right: at1.x, bottom };
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
  const middled = centred(quad, within, best);
  // Held inside the rectangle the answer is of. The search cannot leave it, but a rectangle
  // rounded outwards by a floating point hair would put the wedge back.
  const held = {
    left: Math.max(middled.left, within.left),
    top: Math.max(middled.top, within.top),
    right: Math.min(middled.right, within.right),
    bottom: Math.min(middled.bottom, within.bottom),
  };
  return held.right > held.left && held.bottom > held.top ? held : null;
}

// The crop's shape as a ratio to choose, rather than a rectangle to drag into one.
//
// **In pixels, not in fractions.** The rectangle is fractions of the frame it sits on, so a
// square of them is square only on a square photograph - and the frame those fractions are of is
// the straightened, turned, *uncropped* picture (`CropStore.cropFrame`), not the one a crop
// has already been taken out of.
//
// Every ratio is width over height as it is written, so 16:9 is wide whatever shape the frame is;
// the portrait ones are listed rather than derived, which is what makes a tall crop reachable
// without a second control for the orientation.

import type { Size } from '../../photos/viewer/zoom_pan';
import { clamp, draggedCrop, MINIMUM_CROP, type CropGrip, type CropRect } from './crop_turn';

export const ASPECT_RATIOS = [
  { key: '1:1', ratio: 1 },
  { key: '5:4', ratio: 5 / 4 },
  { key: '4:3', ratio: 4 / 3 },
  { key: '3:2', ratio: 3 / 2 },
  { key: '16:9', ratio: 16 / 9 },
  { key: '4:5', ratio: 4 / 5 },
  { key: '3:4', ratio: 3 / 4 },
  { key: '2:3', ratio: 2 / 3 },
  { key: '9:16', ratio: 9 / 16 },
] as const;

/** One of the ratios above, the frame's own, or whatever else a drag has left. */
export type AspectKey = (typeof ASPECT_RATIOS)[number]['key'] | 'original' | 'custom';

/** What a pick means as a number, or null for the shape that is not a choice. */
export function aspectRatioFor(key: AspectKey, original: number): number | null {
  if (key === 'original') return original;
  return ASPECT_RATIOS.find((each) => each.key === key)?.ratio ?? null;
}

/** The shape a rectangle actually is, on the picture rather than in the frame's fractions. */
export function aspectRatioOf(rect: CropRect, picture: Size): number {
  const height = (rect.bottom - rect.top) * picture.height;
  return height <= 0 ? 0 : ((rect.right - rect.left) * picture.width) / height;
}

/** How near a ratio counts as being at it: a pixel either way on a 1000-pixel crop. */
const SAME_RATIO = 0.002;

/**
 * Which ratio the picker should show for a rectangle, read off the rectangle itself.
 *
 * The frame's own is tried first, so an uncropped 3:2 photograph reads "Original" rather than the
 * ratio that happens to say the same thing.
 */
export function aspectKeyOf(rect: CropRect, picture: Size, original: number): AspectKey {
  const ratio = aspectRatioOf(rect, picture);
  if (near(ratio, original)) return 'original';
  return ASPECT_RATIOS.find((each) => near(ratio, each.ratio))?.key ?? 'custom';
}

/** A shape as the picker would name it, or as a ratio to one where the picker has no name. */
export function aspectLabel(ratio: number): string {
  const listed = ASPECT_RATIOS.find((each) => near(ratio, each.ratio));
  if (listed != null) return listed.key;
  const rounded = (value: number): string => String(Number(value.toFixed(2)));
  return ratio >= 1 ? `${rounded(ratio)}:1` : `1:${rounded(1 / ratio)}`;
}

const near = (ratio: number, of: number): boolean => Math.abs(ratio - of) <= SAME_RATIO * of;

/**
 * The rectangle at `ratio`, centred where it already was.
 *
 * Shrunk to the ratio and never grown to it, which is what keeps the answer inside the frame
 * without a clamp: both edges move inwards, so a rectangle that was inside still is.
 */
export function aspectCrop(rect: CropRect, ratio: number, picture: Size): CropRect {
  const width = (rect.right - rect.left) * picture.width;
  const height = (rect.bottom - rect.top) * picture.height;
  const kept =
    width > height * ratio ? { width: height * ratio, height } : { width, height: width / ratio };
  const half = { x: kept.width / picture.width / 2, y: kept.height / picture.height / 2 };
  const at = { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
  return { left: at.x - half.x, top: at.y - half.y, right: at.x + half.x, bottom: at.y + half.y };
}

/**
 * `draggedCrop` held at `ratio`, in whichever orientation the drag asks for: a corner pivots on
 * the one opposite it and turns portrait or landscape as the pointer crosses the diagonal, a side
 * pivots on the middle of the one opposite it and keeps the orientation it started in. The
 * rectangle shrinks rather than leave the frame.
 */
export function aspectDraggedCrop(
  start: CropRect,
  grip: CropGrip | null,
  by: { x: number; y: number },
  held: number,
  picture: Size,
): CropRect {
  const free = draggedCrop(start, grip, by);
  if (grip == null) return free;

  const freeWidth = (free.right - free.left) * picture.width;
  const freeHeight = (free.bottom - free.top) * picture.height;
  const wide =
    grip.x != null && grip.y != null ? freeWidth >= freeHeight
    : (start.right - start.left) * picture.width >= (start.bottom - start.top) * picture.height;
  const ratio = wide === held >= 1 ? held : 1 / held;

  const anchor = {
    x: grip.x === 'left' ? start.right : grip.x === 'right' ? start.left : (start.left + start.right) / 2,
    y: grip.y === 'top' ? start.bottom : grip.y === 'bottom' ? start.top : (start.top + start.bottom) / 2,
  };
  const room = {
    x: grip.x === 'left' ? anchor.x : grip.x === 'right' ? 1 - anchor.x : 2 * Math.min(anchor.x, 1 - anchor.x),
    y: grip.y === 'top' ? anchor.y : grip.y === 'bottom' ? 1 - anchor.y : 2 * Math.min(anchor.y, 1 - anchor.y),
  };

  // A corner follows the pointer projected onto the rectangle's diagonal.
  const wanted =
    grip.x == null ? freeHeight * ratio
    : grip.y == null ? freeWidth
    : ((freeWidth * ratio + freeHeight) * ratio) / (ratio * ratio + 1);
  const smallest = MINIMUM_CROP * Math.max(picture.width, picture.height * ratio);
  const largest = Math.min(room.x * picture.width, room.y * picture.height * ratio);
  // The minimum wins where the room is smaller, and the slide below keeps that inside the frame.
  const kept = Math.max(Math.min(wanted, largest), smallest);
  const width = kept / picture.width;
  const height = kept / ratio / picture.height;

  const at = {
    x: grip.x === 'left' ? anchor.x - width : grip.x === 'right' ? anchor.x : anchor.x - width / 2,
    y: grip.y === 'top' ? anchor.y - height : grip.y === 'bottom' ? anchor.y : anchor.y - height / 2,
  };
  const left = clamp(at.x, 0, 1 - width);
  const top = clamp(at.y, 0, 1 - height);
  return { left, top, right: left + width, bottom: top + height };
}

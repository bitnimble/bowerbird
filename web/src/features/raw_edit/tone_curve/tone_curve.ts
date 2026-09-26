import { TONE_CURVE_MAX_POINTS, type ToneCurvePoints } from '../../../../../src/schemas/photo_edits';

export const IDENTITY_CURVE: ToneCurvePoints = [[0, 0], [1, 1]];
const GAP = 1 / 1024;
export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export function tangents(points: ToneCurvePoints): number[] {
  const slopes = points.slice(1).map(([x, y], index) => (y - points[index]![1]) / (x - points[index]![0]));
  const result = [slopes[0]!, ...slopes.slice(1).map((slope, index) => {
    const before = slopes[index]!;
    if (before * slope <= 0) return 0;
    const left = points[index + 1]![0] - points[index]![0];
    const right = points[index + 2]![0] - points[index + 1]![0];
    const firstWeight = 2 * right + left;
    const secondWeight = right + 2 * left;
    return (firstWeight + secondWeight) / (firstWeight / before + secondWeight / slope);
  }), slopes.at(-1)!];
  return result;
}

export function evaluate(points: ToneCurvePoints, x: number, derivatives = tangents(points)): number {
  const first = points[0]!;
  if (x <= first[0]) return first[1];
  const last = points.at(-1)!;
  if (x >= last[0]) return last[1] + (x - last[0]) * derivatives.at(-1)!;
  const index = points.findIndex((point) => point[0] > x) - 1;
  const [leftX, leftY] = points[index]!;
  const [rightX, rightY] = points[index + 1]!;
  const width = rightX - leftX;
  const t = (x - leftX) / width;
  return (2 * t ** 3 - 3 * t ** 2 + 1) * leftY
    + (t ** 3 - 2 * t ** 2 + t) * width * derivatives[index]!
    + (-2 * t ** 3 + 3 * t ** 2) * rightY
    + (t ** 3 - t ** 2) * width * derivatives[index + 1]!;
}

export function insertPoint(points: ToneCurvePoints, x: number): { points: ToneCurvePoints; index: number } | null {
  if (points.length >= TONE_CURVE_MAX_POINTS) return null;
  const at = clamp(x, 0, 1);
  const found = points.findIndex((point) => point[0] > at);
  const index = found < 0 ? points.length : found;
  if (index > 0 && at <= points[index - 1]![0] + GAP) return null;
  if (index < points.length && at >= points[index]![0] - GAP) return null;
  const next = points.slice();
  next.splice(index, 0, [at, clamp(evaluate(points, at), points[index - 1]?.[1] ?? 0, points[index]?.[1] ?? 1)]);
  return { points: next, index };
}

export function insertInWidestGap(points: ToneCurvePoints): { points: ToneCurvePoints; index: number } | null {
  let index = 1;
  for (let at = 2; at < points.length; at += 1) {
    if (points[at]![0] - points[at - 1]![0] > points[index]![0] - points[index - 1]![0]) index = at;
  }
  return insertPoint(points, (points[index - 1]![0] + points[index]![0]) / 2);
}

export function movePoint(points: ToneCurvePoints, index: number, x: number, y: number): ToneCurvePoints {
  const next = points.slice();
  if (index === 0) {
    next[0] = x > y
      ? [clamp(x, 0, points[1]![0] - Math.min(GAP, points[1]![0] / 2)), 0]
      : [0, clamp(y, 0, points[1]![1])];
  } else if (index === points.length - 1) {
    next[index] = x < y
      ? [clamp(x, points[index - 1]![0] + Math.min(GAP, (1 - points[index - 1]![0]) / 2), 1), 1]
      : [1, clamp(y, points[index - 1]![1], 1)];
  } else {
    const left = points[index - 1]![0];
    const right = points[index + 1]![0];
    const gap = Math.min(GAP, (right - left) / 3);
    next[index] = [clamp(x, left + gap, right - gap), clamp(y, points[index - 1]![1], points[index + 1]![1])];
  }
  if (next[index]![0] === points[index]![0] && next[index]![1] === points[index]![1]) return points;
  return next;
}

export function removePoint(points: ToneCurvePoints, index: number): ToneCurvePoints {
  if (index <= 0 || index >= points.length - 1) return points;
  return points.filter((_, at) => at !== index);
}

export function nudgePoint(points: ToneCurvePoints, index: number, key: string, step: number): ToneCurvePoints {
  const [x, y] = points[index]!;
  if (index === 0) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (y > 0) return points;
      return movePoint(points, index, clamp(x + (key === 'ArrowRight' ? step : -step), 0, 1), 0);
    }
    if (x > 0) return points;
    return movePoint(points, index, 0, clamp(y + (key === 'ArrowUp' ? step : -step), 0, 1));
  }
  if (index === points.length - 1) {
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      if (y < 1) return points;
      return movePoint(points, index, clamp(x + (key === 'ArrowRight' ? step : -step), 0, 1), 1);
    }
    if (x < 1) return points;
    return movePoint(points, index, 1, clamp(y + (key === 'ArrowUp' ? step : -step), 0, 1));
  }
  return movePoint(points, index,
    x + (key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0),
    y + (key === 'ArrowUp' ? step : key === 'ArrowDown' ? -step : 0));
}

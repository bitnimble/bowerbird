// Hue turns anticlockwise from the right in a `-1..1` square, as `colour_wheel.slang` draws it.
import type { ColourNode } from '../../../../../src/schemas/photo_edits';

export const CHANNELS = [10, 30, 55, 80, 110] as const;

/** A channel's lightness, or null for the nodes that reach every lightness. */
export type Channel = number | null;

/** `lattice::ANY_LIGHTNESS_AT`. */
export const ANY_LIGHTNESS_AT = 55;

export const MOST_HUE_REACH = 180;
const HUE_REACH = 30;
const CHROMA_REACH = 6;
export const LIGHTNESS_REACH = 20;
export const LEAST_HUE_REACH = 5;

/** A place on the wheel: hue in degrees, chroma in ZCAM units. */
export interface Hued {
  hue: number;
  chroma: number;
}

/** A point in the wheel's `-1..1` square. */
export interface Point {
  x: number;
  y: number;
}

export function lightnessOf(channel: Channel): number {
  return channel ?? ANY_LIGHTNESS_AT;
}

export function channelOf(node: ColourNode): Channel {
  return node.lightness == null ? null : nearestChannel(node.lightness);
}

export function inChannel(node: ColourNode, channel: Channel): boolean {
  return channelOf(node) === channel;
}

export function nearestChannel(lightness: number): number {
  return CHANNELS.reduce((best, channel) =>
    Math.abs(channel - lightness) < Math.abs(best - lightness) ? channel : best,
  );
}

/** A node at `at` in `channel`, moving nothing yet. */
export function nodeAt(at: Hued, channel: Channel, rim: number): ColourNode {
  const hue = tidy(wrapped(at.hue));
  const chroma = tidy(Math.min(at.chroma, rim));
  return {
    hue,
    chroma,
    lightness: channel,
    targetHue: hue,
    targetChroma: chroma,
    targetLightness: lightnessOf(channel),
    hueReach: HUE_REACH,
    chromaReach: tidy(Math.min(CHROMA_REACH, rim - chroma)),
    lightnessReach: channel == null ? 0 : LIGHTNESS_REACH,
  };
}

/**
 * `start`, as a drag began, taken to `to`: its saturation range as it was, short of whatever would
 * cross the rim.
 */
export function movedSource(start: ColourNode, to: Hued, rim: number): ColourNode {
  const chroma = tidy(Math.min(to.chroma, rim));
  return {
    ...start,
    hue: tidy(wrapped(to.hue)),
    chroma,
    chromaReach: tidy(Math.min(start.chromaReach, rim - chroma)),
  };
}

export function movedTarget(node: ColourNode, to: Hued): ColourNode {
  return { ...node, targetHue: tidy(wrapped(to.hue)), targetChroma: tidy(to.chroma) };
}

export type Reach = 'hueReach' | 'chromaReach';

export function hueReachTo(node: ColourNode, at: Hued): number {
  return heldHueReach(Math.abs(wrapped(at.hue - node.hue + 180) - 180));
}

export function chromaReachTo(node: ColourNode, at: Hued, rim: number): number {
  return heldChromaReach(node, at.chroma - node.chroma, rim);
}

export function steppedReach(
  node: ColourNode,
  reach: Reach,
  by: number,
  rim: number,
): Partial<ColourNode> {
  return reach === 'hueReach'
    ? { hueReach: heldHueReach(node.hueReach + by) }
    : { chromaReach: heldChromaReach(node, node.chromaReach + by, rim) };
}

export function reachesEveryHue(node: ColourNode): boolean {
  return node.hueReach >= MOST_HUE_REACH;
}

function heldHueReach(reach: number): number {
  return tidy(Math.min(Math.max(reach, LEAST_HUE_REACH), MOST_HUE_REACH));
}

function heldChromaReach(node: ColourNode, reach: number, rim: number): number {
  return tidy(Math.max(Math.min(reach, rim - node.chroma), 0));
}

export function opponent({ hue, chroma }: Hued): [number, number] {
  const turn = (hue * Math.PI) / 180;
  return [chroma * Math.cos(turn), chroma * Math.sin(turn)];
}

export function hued(a: number, b: number): Hued {
  return { hue: wrapped((Math.atan2(b, a) * 180) / Math.PI), chroma: Math.hypot(a, b) };
}

export function pointOf(at: Hued, rim: number): Point {
  const [a, b] = opponent(at);
  return { x: a / rim, y: -b / rim };
}

/** The place under `point`, held inside the rim. */
export function huedAt(point: Point, rim: number): Hued {
  const at = hued(point.x * rim, -point.y * rim);
  return { hue: at.hue, chroma: Math.min(at.chroma, rim) };
}

/**
 * The chroma a node reaches: out by its reach, and in by as much in square-root chroma, the
 * lattice's own axis.
 */
export function chromaReached(node: ColourNode): { inner: number; outer: number } {
  const root = Math.sqrt(node.chroma);
  const outer = node.chroma + node.chromaReach;
  const rootReach = Math.sqrt(outer) - root;
  return { inner: Math.max(root - rootReach, 0) ** 2, outer };
}

/** The outline of what a node reaches: its hue either side, and its chroma reached. */
export function reachPath(node: ColourNode, rim: number): string {
  const { inner, outer } = chromaReached(node);
  if (reachesEveryHue(node)) {
    return [circle(outer, rim), inner > 0 ? circle(inner, rim) : ''].join(' ');
  }
  const from = node.hue - node.hueReach;
  const to = node.hue + node.hueReach;
  const large = node.hueReach > 90 ? 1 : 0;
  const at = (hue: number, chroma: number): string => {
    const point = pointOf({ hue, chroma }, rim);
    return `${round(point.x)} ${round(point.y)}`;
  };
  const outerRadius = round(outer / rim);
  const innerRadius = round(inner / rim);
  return [
    `M${at(from, inner)}`,
    `L${at(from, outer)}`,
    `A${outerRadius} ${outerRadius} 0 ${large} 0 ${at(to, outer)}`,
    `L${at(to, inner)}`,
    inner > 0 ? `A${innerRadius} ${innerRadius} 0 ${large} 1 ${at(from, inner)}` : '',
    'Z',
  ].join(' ');
}

/** The edge of what the display shows, from its chroma at each whole degree of hue. */
export function edgePath(edge: readonly number[], rim: number): string {
  if (edge.length === 0) return '';
  return `${edge
    .map((chroma, degree) => {
      const point = pointOf({ hue: degree, chroma: Math.min(chroma, rim) }, rim);
      return `${degree === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`;
    })
    .join(' ')} Z`;
}

function circle(chroma: number, rim: number): string {
  const r = round(chroma / rim);
  return `M${r} 0 A${r} ${r} 0 1 0 ${-r} 0 A${r} ${r} 0 1 0 ${r} 0 Z`;
}

function wrapped(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function tidy(value: number): number {
  return Math.round(value * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

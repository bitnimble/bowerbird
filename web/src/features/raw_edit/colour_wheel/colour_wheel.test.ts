import { describe, expect, test } from 'bun:test';
import {
  chromaReachTo,
  hueReachTo,
  huedAt,
  movedSource,
  movedTarget,
  nodeAt,
  pointOf,
  reachPath,
} from './colour_wheel';

describe('the colour wheel', () => {
  test('puts hue anticlockwise from the right and chroma outward to the rim', () => {
    expect(pointOf({ hue: 0, chroma: 20 }, 40)).toEqual({ x: 0.5, y: -0 });
    const up = pointOf({ hue: 90, chroma: 40 }, 40);
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(-1);
  });

  test('reads back the place it drew, held inside the rim', () => {
    const back = huedAt(pointOf({ hue: 215, chroma: 12 }, 40), 40);
    expect(back.hue).toBeCloseTo(215);
    expect(back.chroma).toBeCloseTo(12);
    expect(huedAt({ x: 2, y: 0 }, 40)).toEqual({ hue: 0, chroma: 40 });
  });

  test('adds a node that moves nothing, at its channel', () => {
    expect(nodeAt({ hue: 370, chroma: 8.123 }, 30)).toEqual({
      hue: 10,
      chroma: 8.12,
      lightness: 30,
      targetHue: 10,
      targetChroma: 8.12,
      targetLightness: 30,
      hueReach: 30,
      chromaReach: 6,
      lightnessReach: 20,
    });
    const everywhere = nodeAt({ hue: 200, chroma: 5 }, null);
    expect(everywhere.lightness).toBeNull();
    expect(everywhere.targetLightness).toBe(55);
    expect(everywhere.lightnessReach).toBe(0);
  });

  test('carries the target along when the node moves', () => {
    const node = movedTarget(nodeAt({ hue: 0, chroma: 10 }, 55), { hue: 0, chroma: 15 });
    const moved = movedSource(node, { hue: 90, chroma: 10 });
    expect(moved.hue).toBe(90);
    expect(moved.targetHue).toBeCloseTo(63.43, 1);
    expect(moved.targetChroma).toBeCloseTo(11.18, 1);
  });

  test('sets the reaches from where their edges are dragged', () => {
    const node = nodeAt({ hue: 350, chroma: 10 }, 55);
    expect(hueReachTo(node, { hue: 20, chroma: 10 })).toBe(30);
    expect(hueReachTo(node, { hue: 350, chroma: 10 })).toBe(1);
    expect(chromaReachTo(node, { hue: 350, chroma: 18.5 })).toBe(8.5);
    expect(chromaReachTo(node, { hue: 350, chroma: 4 })).toBe(0);
  });

  test('outlines a reach as a sector, or a ring once it reaches every hue', () => {
    const node = nodeAt({ hue: 0, chroma: 16 }, 55);
    expect(reachPath(node, 40)).toMatch(/^M.* A.* A.* Z$/);
    expect(reachPath({ ...node, hueReach: 180 }, 40)).not.toContain('L');
  });
});

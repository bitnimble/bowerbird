import { describe, expect, test } from 'bun:test';
import {
  chromaReachTo,
  chromaReached,
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
    expect(nodeAt({ hue: 370, chroma: 8.123 }, 30, 40)).toEqual({
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
    const everywhere = nodeAt({ hue: 200, chroma: 5 }, null, 40);
    expect(everywhere.lightness).toBeNull();
    expect(everywhere.targetLightness).toBe(55);
    expect(everywhere.lightnessReach).toBe(0);
  });

  test('leaves the output colour where it is when the node moves', () => {
    const node = movedTarget(nodeAt({ hue: 0, chroma: 10 }, 55, 40), { hue: 0, chroma: 15 });
    const moved = movedSource(node, { hue: 90, chroma: 10 }, 40);
    expect(moved).toMatchObject({ hue: 90, chroma: 10, targetHue: 0, targetChroma: 15 });
  });

  test('keeps the outer saturation edge on the wheel, the range coming back as the node does', () => {
    const start = nodeAt({ hue: 0, chroma: 10 }, 55, 40);
    expect(movedSource(start, { hue: 0, chroma: 37 }, 40)).toMatchObject({
      chroma: 37,
      chromaReach: 3,
    });
    expect(movedSource(start, { hue: 0, chroma: 45 }, 40)).toMatchObject({
      chroma: 40,
      chromaReach: 0,
    });
    expect(movedSource(start, { hue: 0, chroma: 20 }, 40).chromaReach).toBe(6);
    expect(movedSource(start, { hue: 0, chroma: 0.5 }, 40).chroma).toBe(0.5);
    expect(nodeAt({ hue: 0, chroma: 38 }, 55, 40)).toMatchObject({ chroma: 38, chromaReach: 2 });
    expect(chromaReachTo(start, { hue: 0, chroma: 45 }, 40)).toBe(30);
  });

  test('sets the reaches from where their edges are dragged', () => {
    const node = nodeAt({ hue: 350, chroma: 10 }, 55, 40);
    expect(hueReachTo(node, { hue: 20, chroma: 10 })).toBe(30);
    expect(hueReachTo(node, { hue: 350, chroma: 10 })).toBe(5);
    expect(chromaReachTo(node, { hue: 350, chroma: 18.5 }, 40)).toBe(8.5);
    expect(chromaReachTo(node, { hue: 350, chroma: 4 }, 40)).toBe(0);
  });

  test('reaches as far inward in square-root chroma as outward', () => {
    const { inner, outer } = chromaReached(nodeAt({ hue: 0, chroma: 16 }, 55, 40));
    expect(outer).toBe(22);
    expect(inner).toBeCloseTo((4 - (Math.sqrt(22) - 4)) ** 2, 10);
  });

  test('outlines a reach as a sector, or a ring once it reaches every hue', () => {
    const node = nodeAt({ hue: 0, chroma: 16 }, 55, 40);
    expect(reachPath(node, 40)).toMatch(/^M.* A.* A.* Z$/);
    expect(reachPath({ ...node, hueReach: 180 }, 40)).not.toContain('L');
  });
});

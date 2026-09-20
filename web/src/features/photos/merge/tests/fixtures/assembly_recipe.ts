import type { AssemblyRecipe, Seams } from '../../../../../../../src/schemas/assembly';
import { type AssemblyJob } from '../../../../../../../src/schemas/assembly';
import type { Compositor } from '../../merge_presenter';
import type { Rect } from '../../merge_rect';
import { saveMergeSession } from '../../merge_storage';

/** A presenter under test that is not being asked what it drew. */
export const NO_COMPOSITOR: Compositor = { draw: () => undefined, drawSettled: () => undefined };

/** The seams of a pick set that takes the base everywhere: no pieces, so nothing is drawn over it. */
export function noSeams(pick: number[], base = 0): Seams {
  return { pick, base, vertices: [], tiles: [], source: [], zone: [], corridor: [], warp: [], exposure: [] };
}

/** A carve job that has finished, over `recipe`, with no layers to decode. */
export function readyJobFixture(recipe: AssemblyRecipe = untiledRecipeFixture()): AssemblyJob {
  return {
    id: 'job1',
    photoIds: ['frame001', 'frame002'],
    status: 'ready',
    fraction: 1,
    carved: {
      analysed: { recipe, unaligned: false, warnings: [] },
      layers: [],
    },
  };
}

/** `assemblyRecipeFixture`'s tiles, as the rectangles a session seeds them from. */
export const FIXTURE_SEEDS: Rect[] = [
  { x0: 0, y0: 0, x1: 500, y1: 500 },
  { x0: 500, y0: 0, x1: 1000, y1: 500 },
];

/** A reader's session over `readyJobFixture` that seeded `FIXTURE_SEEDS` and picked `picks`. */
export function saveSeededSession(jobId: string, picks = [0, 0]): void {
  saveMergeSession(jobId, { picks, base: 0, seeds: FIXTURE_SEEDS });
}

/** Seams for `pick` over the base 0: one triangle `size` canvas pixels a side, taking frame 1, grown from `zone`. */
export function triangleSeams(pick: number[], zone: number, size: number): Seams {
  return {
    pick,
    base: 0,
    vertices: [
      [0, 0],
      [size, 0],
      [0, size],
    ],
    tiles: [[0, 1, 2]],
    source: [1],
    zone: [zone],
    corridor: [0.01],
    warp: [[1, 0, 0, 1, 0, 0]],
    exposure: [1],
  };
}

/** What the analysis answers: the geometry, with no tiles yet. */
export function untiledRecipeFixture(): AssemblyRecipe {
  return { ...assemblyRecipeFixture(), vertices: [], tiles: [], pick: [] };
}

/** A square canvas, two tiles sharing an edge (vertices 1 and 2), two sources. */
export function assemblyRecipeFixture(): AssemblyRecipe {
  return {
    version: 1,
    sources: [
      { photoId: 'frame001', size: [100, 100], rotation: [0, 0, 0, 1], focal: 50, lens: { crop: 1 }, gain: 1 },
      { photoId: 'frame002', size: [100, 100], rotation: [0, 0, 0, 1], focal: 50, lens: { crop: 1 }, gain: 1 },
    ],
    projection: 'rectilinear',
    canvas: [1000, 1000],
    centre: [500, 500],
    radiansPerPixel: 0.001,
    crop: [0, 0, 1, 1],
    reference: 0,
    vertices: [
      [0, 0],
      [500, 0],
      [500, 500],
      [0, 500],
      [1000, 0],
      [1000, 500],
    ],
    tiles: [
      [0, 1, 2, 3],
      [1, 4, 5, 2],
    ],
    pick: [0, 0],
    base: 0,
  };
}

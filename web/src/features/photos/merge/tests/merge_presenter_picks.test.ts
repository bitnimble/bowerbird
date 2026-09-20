import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInAction } from 'mobx';
import { MOST_FEATHER, type AssemblyRecipe, type Seams } from '../../../../../../src/schemas/assembly';
import { MemoryStorage } from '../../../../test_storage';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { FEATHER_FLOOR_PX, type DrawnLayer } from '../merge_layers';
import { MergePresenter, type Compositor } from '../merge_presenter';
import { loadMergeSession } from '../merge_storage';
import { MergeStore } from '../merge_store';

// Three sources, two tiles split down the middle of a square canvas.
const recipe = {
  version: 1,
  sources: ['a', 'b', 'c'].map((photoId) => ({
    photoId,
    size: [10, 10],
    rotation: [0, 0, 0, 1],
    focal: 1,
    lens: { crop: 1 },
    gain: 1,
  })),
  projection: 'rectilinear',
  canvas: [10, 10],
  centre: [5, 5],
  radiansPerPixel: 0.01,
  crop: [0, 0, 1, 1],
  reference: 0,
  vertices: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [5, 0],
    [5, 10],
  ],
  tiles: [
    [0, 4, 5, 3],
    [4, 1, 2, 5],
  ],
  pick: [0, 0],
  base: 0,
} as unknown as AssemblyRecipe;

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});

function build(): { store: MergeStore; presenter: MergePresenter; draws: { base: number; layers: DrawnLayer[] }[] } {
  const store = new MergeStore();
  runInAction(() => {
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    // No seam volume, as `settleRecipe` would find: the tiles are drawn as they are.
    store.unseamed = true;
    store.status = 'ready';
  });
  const draws: { base: number; layers: DrawnLayer[] }[] = [];
  const compositor: Compositor = {
    draw: (base, layers) => draws.push({ base, layers }),
    drawSettled: () => undefined,
  };
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), compositor);
  return { store, presenter, draws };
}

test('a pick tells the compositor that tile and source', () => {
  const { store, presenter, draws } = build();
  presenter.pick(0, 1);
  expect(store.picks).toEqual([1, 0]);
  expect(draws.at(-1)?.layers.some((l) => l.source === 1)).toBe(true);
});

test('the base layer is never given a mask of its own', () => {
  const { presenter, draws } = build();
  presenter.pick(0, 1);
  expect(draws.at(-1)?.base).toBe(0);
  expect(draws.at(-1)?.layers.map((l) => l.source)).toEqual([1]);
});

// Twice §5.2's `W`: half the corridor, capped at the recipe's feather, over the layer's long edge.
test('a layer is feathered over its corridor, capped at the feather the reader set', () => {
  const { store, presenter, draws } = build();
  const seams: Seams = {
    pick: [1, 0],
    base: 0,
    vertices: recipe.vertices,
    tiles: [recipe.tiles[0]!],
    source: [1],
    zone: [0],
    corridor: [0.02],
    warp: [[1, 0, 0, 1, 0, 0]],
    exposure: [1],
  };
  runInAction(() => {
    store.layerSize = { width: 1000, height: 500 };
    store.unseamed = false;
    store.solved.set(store.keyOf([1, 0]), { seams, geometry: store.geometry });
  });
  presenter.pick(0, 1);
  expect(draws.at(-1)?.layers[0]?.feather).toBe(5);

  presenter.setFeather(0.005);
  expect(store.recipe?.feather).toBe(0.005);
  expect(draws.at(-1)?.layers[0]?.feather).toBe(10);
  expect(loadMergeSession('')?.feather).not.toBe(0.005);
  presenter.settleFeather(0.005);
  expect(loadMergeSession('')?.feather).toBe(0.005);

  presenter.setFeather(0);
  expect(draws.at(-1)?.layers[0]?.feather).toBe(4);
  presenter.setFeather(1);
  expect(store.recipe?.feather).toBe(MOST_FEATHER);
  // Twice the widest feather is past the tiles' corridor, which caps it instead.
  expect(draws.at(-1)?.layers[0]?.feather).toBe(20);
});

test('the least ramp is twice the render least half-width', () => {
  const weight = readFileSync(
    join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'native', 'rawshim', 'src', 'assembly_weight.rs'),
    'utf8',
  );
  const least = Number(weight.match(/pub const W_HIGH_PX: f32 = ([\d.]+);/)?.[1]);
  expect(FEATHER_FLOOR_PX).toBe(2 * least);
});

test('hovering a swatch previews without committing the pick', () => {
  const { store, presenter, draws } = build();
  runInAction(() => (store.openTile = 0));
  presenter.hoverSwatch(2);
  expect(store.picks).toEqual([0, 0]);
  expect(draws.at(-1)?.layers.some((l) => l.source === 2)).toBe(true);
  presenter.hoverSwatch(null);
  expect(draws.at(-1)?.layers.some((l) => l.source === 2)).toBe(false);
});

test('undo reverses the last pick, one at a time', () => {
  const { store, presenter } = build();
  presenter.pick(0, 1);
  presenter.pick(1, 2);
  presenter.undo();
  expect(store.picks).toEqual([1, 0]);
  presenter.undo();
  expect(store.picks).toEqual([0, 0]);
  expect(store.canUndo).toBe(false);
});

test('redo puts back what undo took, and a fresh pick forgets it', () => {
  const { store, presenter } = build();
  presenter.pick(0, 1);
  presenter.undo();
  expect(store.canRedo).toBe(true);
  presenter.redo();
  expect(store.picks).toEqual([1, 0]);
  expect(store.canRedo).toBe(false);
  presenter.undo();
  presenter.pick(1, 2);
  expect(store.canRedo).toBe(false);
  presenter.redo();
  expect(store.picks).toEqual([0, 2]);
});

test('undo on an empty history does nothing', () => {
  const { store, presenter } = build();
  presenter.undo();
  expect(store.picks).toEqual([0, 0]);
});

// §2.8's `[` and `]`, which is how a reader walks every tile without hunting for the outlines.
test('stepping between tiles wraps at both ends and opens from nothing', () => {
  const { store, presenter } = build();
  presenter.stepTile(1);
  expect(store.openTile).toBe(0);
  presenter.stepTile(1);
  expect(store.openTile).toBe(1);
  presenter.stepTile(1);
  expect(store.openTile).toBe(0);
  presenter.stepTile(-1);
  expect(store.openTile).toBe(1);
});

// A preview left over from the tile just left would otherwise draw the next one from a source the
// reader never asked about, since `MergeStore.drawing` substitutes whatever `hoveredSwatch` holds.
test('opening a tile drops the preview the last one was left showing', () => {
  const { store, presenter, draws } = build();
  presenter.openTile(0);
  presenter.stepSwatch(1);
  expect(store.hoveredSwatch).toBe(1);
  presenter.stepTile(1);
  expect(store.hoveredSwatch).toBeNull();
  expect(draws.at(-1)?.layers).toEqual([]);
});

// §2.8's arrows: from the tile's own pick, so the first press is a step off what is on screen.
test('stepping between swatches previews from the tiles current pick, and wraps', () => {
  const { store, presenter, draws } = build();
  presenter.openTile(0);
  presenter.stepSwatch(1);
  expect(store.hoveredSwatch).toBe(1);
  expect(store.picks).toEqual([0, 0]);
  presenter.stepSwatch(1);
  expect(store.hoveredSwatch).toBe(2);
  presenter.stepSwatch(1);
  expect(store.hoveredSwatch).toBe(0);
  expect(draws.at(-1)?.layers).toEqual([]);
});

test('toggleLines hides the outlines without touching the picture', () => {
  const { store, presenter, draws } = build();
  expect(store.showingLines).toBe(true);
  const drawn = draws.length;
  presenter.toggleLines();
  expect(store.showingLines).toBe(false);
  expect(draws.length).toBe(drawn);
});

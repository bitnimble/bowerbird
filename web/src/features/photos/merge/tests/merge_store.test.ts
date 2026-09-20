import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import type { Seams } from '../../../../../../src/schemas/assembly';
import { MergeStore, seamsKey } from '../merge_store';
import { assemblyRecipeFixture, triangleSeams } from './fixtures/assembly_recipe';

function ready(): MergeStore {
  const store = new MergeStore();
  const recipe = assemblyRecipeFixture();
  runInAction(() => {
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    store.status = 'ready';
  });
  return store;
}

// What the flyout is placed against, in the same pixels the outline is drawn in: the second tile
// is the right half of the canvas, so it reaches the far edge rather than the near one.
test('tilePolygons is each outline, in the decoded layer pixels', () => {
  const store = ready();
  runInAction(() => (store.layerSize = { width: 500, height: 500 }));
  expect(store.tilePolygons).toEqual([
    [
      [0, 0],
      [250, 0],
      [250, 250],
      [0, 250],
    ],
    [
      [250, 0],
      [500, 0],
      [500, 250],
      [250, 250],
    ],
  ]);
});

test('the geometry names the outlines, so the same tiles read the same key', () => {
  const store = ready();
  const before = store.geometry;
  runInAction(() => (store.recipe = { ...store.recipe!, vertices: store.recipe!.vertices.map(([x, y]) => [x + 1, y]) }));
  expect(store.geometry).not.toBe(before);
  runInAction(() => (store.recipe = assemblyRecipeFixture()));
  expect(store.geometry).toBe(before);
});

const solvedFor = (pick: number[], zone = 0): Seams => triangleSeams(pick, zone, 500);

function solve(store: MergeStore, seams: Seams, geometry = store.geometry): void {
  runInAction(() =>
    store.solved.set(seamsKey(geometry, store.balancedFeather, seams.base, seams.pick), { seams, geometry }),
  );
}

test('the pieces are the solved seams, scaled to the layer, each opening the tile it lies under', () => {
  const store = ready();
  runInAction(() => (store.layerSize = { width: 500, height: 500 }));
  solve(store, solvedFor([1, 0]));
  runInAction(() => (store.picks = [1, 0]));
  expect(store.pieces).toEqual([{ tile: 0, d: 'M0,0L250,0L0,250Z' }]);
});

// Nothing solved for what is shown: the latest solve stands in, so the picture never shows a tile
// that has not been grown.
test('drawnSeams stand in with the latest solve over this base', () => {
  const store = ready();
  const seams = solvedFor([1, 0]);
  solve(store, seams);
  expect(store.drawnSeams?.seams).toBe(seams);

  runInAction(() => (store.base = 1));
  expect(store.drawnSeams).toBeNull();
  expect(store.pieces).toEqual([]);
});

test('an unsolved hover stands in with the page picks seams, not the last hovers', () => {
  const store = ready();
  const own = solvedFor([0, 0]);
  solve(store, own);
  solve(store, solvedFor([1, 0]));
  runInAction(() => {
    store.openTile = 1;
    store.hoveredSwatch = 1;
  });
  expect(store.drawnSeams?.seams).toBe(own);
});

test('seams balanced over another feather stand in for their own picks before any others', () => {
  const store = ready();
  const own = solvedFor([1, 0]);
  solve(store, own);
  runInAction(() => (store.balancedFeather = 0.05));
  solve(store, solvedFor([1, 1]));
  runInAction(() => (store.balancedFeather = 0.07));
  runInAction(() => (store.picks = [1, 0]));
  expect(store.drawnSeams?.seams).toBe(own);
});

test('a solved hover draws its own seams', () => {
  const store = ready();
  solve(store, solvedFor([0, 0]));
  const hovered = solvedFor([0, 1]);
  solve(store, hovered);
  runInAction(() => {
    store.openTile = 1;
    store.hoveredSwatch = 1;
  });
  expect(store.drawnSeams?.seams).toBe(hovered);
});

// A seed just added or dropped has no solve of its own yet, and its tile indices mean nothing to
// seams solved over another tile set: those still draw, but open nothing.
test('seams from another tile set stand in, and their pieces open no tile', () => {
  const store = ready();
  solve(store, solvedFor([1, 0]), 'elsewhere');
  solve(store, solvedFor([1, 1]));
  runInAction(() => (store.picks = [0, 0]));
  expect(store.pieces.map(({ tile }) => tile)).toEqual([0]);

  const other = ready();
  solve(other, solvedFor([1, 0]), 'elsewhere');
  expect(other.pieces.map(({ tile }) => tile)).toEqual([null]);
});

test('with nothing to solve against, the pieces are the tiles', () => {
  const store = ready();
  runInAction(() => (store.unseamed = true));
  expect(store.pieces.map(({ tile }) => tile)).toEqual([0, 1]);
});

test('a swatch is outlined by its own growth, then the largest another frame found, then the tile', () => {
  const store = ready();
  runInAction(() => (store.openTile = 1));
  expect(store.outlineFor(1)).toEqual(store.tilePolygons[1]!);

  const small = { ...solvedFor([0, 0], 1), vertices: [[0, 0], [10, 0], [0, 10]] as [number, number][] };
  solve(store, small);
  solve(store, solvedFor([0, 1], 1));
  expect(store.outlineFor(0)).toEqual([
    [0, 0],
    [10, 0],
    [0, 10],
  ]);
  expect(store.outlineFor(1)).toEqual([
    [0, 0],
    [500, 0],
    [0, 500],
  ]);
  expect(store.grownOpen).toEqual(store.outlineFor(1));
});

test('a swatch is read where its piece is read, and one refused is read in place', () => {
  const store = ready();
  runInAction(() => {
    store.layerSize = { width: 500, height: 500 };
    store.openTile = 1;
  });
  solve(store, { ...solvedFor([0, 1], 1), warp: [[1, 0, 0, 1, 40, -20]] });

  expect(store.readFor(1)).toEqual([
    [20, -10],
    [270, -10],
    [20, 240],
  ]);
  expect(store.readFor(0)).toEqual(store.outlineFor(0));
});

test('an open tile is searching until every frame of it is solved or refused', () => {
  const store = ready();
  runInAction(() => {
    store.recipe = { ...store.recipe!, seamVolume: 'key' };
    store.openTile = 1;
  });
  const picksWith = (source: number): number[] => store.picks.map((held, tile) => (tile === 1 ? source : held));
  expect(store.searching).toBe(true);

  solve(store, solvedFor(picksWith(0), 1));
  expect(store.searching).toBe(true);
  runInAction(() => store.unsolvable.add(store.keyOf(picksWith(1))));
  expect(store.searching).toBe(false);

  runInAction(() => (store.openTile = null));
  expect(store.searching).toBe(false);
});

test('with nothing to solve against, no tile is searching', () => {
  const store = ready();
  runInAction(() => (store.openTile = 1));
  expect(store.searching).toBe(false);
  runInAction(() => {
    store.recipe = { ...store.recipe!, seamVolume: 'key' };
    store.unseamed = true;
  });
  expect(store.searching).toBe(false);
});

test('swatches name every frame for the open tile, and none while nothing is open', () => {
  const store = ready();
  expect(store.swatches).toHaveLength(0);
  runInAction(() => (store.openTile = 0));
  expect(store.swatches.map(({ source, name }) => [source, name])).toEqual([
    [0, 'frame001'],
    [1, 'frame002'],
  ]);
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { DEFAULT_FEATHER, type Seams } from '../../../../../../src/schemas/assembly';
import { compositesApi } from '../../../../api/composites';
import { MemoryStorage } from '../../../../test_storage';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import type { DrawnLayer } from '../merge_layers';
import { MergePresenter } from '../merge_presenter';
import { MergePresenterStrings } from '../merge_presenter.strings';
import { loadMergeSession } from '../merge_storage';
import { MergeStore } from '../merge_store';
import { assemblyRecipeFixture, FIXTURE_SEEDS, NO_COMPOSITOR, triangleSeams } from './fixtures/assembly_recipe';

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});

/** A presenter over a recipe with nothing to solve against, so nothing reaches the server. */
function build(): { store: MergeStore; presenter: MergePresenter } {
  const store = new MergeStore();
  runInAction(() => {
    const recipe = assemblyRecipeFixture();
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    store.unseamed = true;
    store.status = 'ready';
  });
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), NO_COMPOSITOR);
  return { store, presenter };
}

test('a click seeds a square tile around it, appended last on the base, and opens it', () => {
  const { store, presenter } = build();
  presenter.seed({ x: 250, y: 250 });
  const recipe = store.recipe!;
  expect(recipe.tiles).toHaveLength(3);
  expect(store.picks).toEqual([0, 0, 0]);
  expect(store.openTile).toBe(2);
  expect(recipe.tiles[2]!.map((v) => recipe.vertices[v])).toEqual([
    [245, 245],
    [255, 245],
    [255, 255],
    [245, 255],
  ]);
});

test('a seed closed with nothing picked is gone again, recipe and all', () => {
  const { store, presenter } = build();
  const before = store.recipe;
  presenter.seed({ x: 250, y: 250 });
  presenter.openTile(null);
  expect(store.recipe).toEqual(before!);
  expect(store.picks).toEqual([0, 0]);
  expect(loadMergeSession('')?.seeds).toEqual(FIXTURE_SEEDS);
});

test('a seed a frame was picked for stays, and is kept across a reload', () => {
  const { store, presenter } = build();
  presenter.seed({ x: 250, y: 250 });
  presenter.pick(2, 1);
  presenter.openTile(null);
  expect(store.recipe!.tiles).toHaveLength(3);
  expect(store.picks).toEqual([0, 0, 1]);
  expect(loadMergeSession('')).toEqual({
    picks: [0, 0, 1],
    base: 0,
    seeds: [...FIXTURE_SEEDS, { x0: 245, y0: 245, x1: 255, y1: 255 }],
    takes: ['subject', 'subject', 'subject'],
    feather: DEFAULT_FEATHER,
  });
});

test('a second click while a fresh seed is open trades it for the new one', () => {
  const { store, presenter } = build();
  presenter.seed({ x: 250, y: 250 });
  presenter.seed({ x: 600, y: 600 });
  const recipe = store.recipe!;
  expect(recipe.tiles).toHaveLength(3);
  expect(recipe.vertices[recipe.tiles[2]![0]!]).toEqual([595, 595]);
  expect(store.openTile).toBe(2);
});

test('a hovered swatch does not count as a pick for keeping a seed', () => {
  const { store, presenter } = build();
  presenter.seed({ x: 250, y: 250 });
  presenter.hoverSwatch(1);
  presenter.openTile(null);
  expect(store.recipe!.tiles).toHaveLength(2);
});

// The history is a stack of `picks` arrays over a tile set that seeds grow, so an entry from before
// a seed is one short of today's tiles.
test('an undo across a seed restores picks sized to the tiles there are now', () => {
  const { store, presenter } = build();
  presenter.pick(0, 1);
  presenter.seed({ x: 250, y: 250 });
  presenter.pick(2, 1);
  presenter.undo();
  expect(store.picks).toEqual([1, 0, 0]);
  presenter.undo();
  expect(store.picks).toEqual([0, 0, 0]);
  presenter.redo();
  presenter.redo();
  expect(store.picks).toEqual([1, 0, 1]);
});

test('a click off the picture, or at no point at all, seeds nothing', () => {
  const { store, presenter } = build();
  presenter.seed({ x: -1, y: 250 });
  presenter.seed({ x: 250, y: 1001 });
  presenter.seed({ x: Number.NaN, y: Number.NaN });
  expect(store.recipe!.tiles).toHaveLength(2);
  expect(store.openTile).toBeNull();
});

test('a read-only page and an unloaded one seed nothing', () => {
  const { store, presenter } = build();
  runInAction(() => (store.readOnly = true));
  presenter.seed({ x: 250, y: 250 });
  expect(store.recipe!.tiles).toHaveLength(2);

  const empty = new MergeStore();
  new MergePresenter(empty, new ToastsPresenter(new ToastsStore()), NO_COMPOSITOR).seed({ x: 0, y: 0 });
  expect(empty.recipe).toBeNull();
});

const solving = { solveSeams: compositesApi.solveSeams };
/** Presenters a test left with a solve pending, which would otherwise answer into the next test. */
const live: MergePresenter[] = [];
afterEach(() => {
  for (const presenter of live.splice(0)) presenter.finish();
  compositesApi.solveSeams = solving.solveSeams;
});

/** A presenter over a carve that left its seam volume, drawing into `drawn`. */
function carved(): {
  store: MergeStore;
  presenter: MergePresenter;
  drawn: DrawnLayer[][];
  asked: number[][][];
  toasts: ToastsStore;
} {
  const store = new MergeStore();
  runInAction(() => {
    const recipe = { ...assemblyRecipeFixture(), seamVolume: 'key' };
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    store.status = 'ready';
  });
  const drawn: DrawnLayer[][] = [];
  const asked: number[][][] = [];
  compositesApi.solveSeams = (_recipe, picks) => {
    asked.push(picks);
    return Promise.resolve({ seams: picks.map(seamsFor) });
  };
  const toasts = new ToastsStore();
  const presenter = new MergePresenter(store, new ToastsPresenter(toasts), {
    draw: (_base, layers) => drawn.push(layers),
    drawSettled: () => undefined,
  });
  live.push(presenter);
  return { store, presenter, drawn, asked, toasts };
}

/** One triangle taking frame 1, under the first tile off the base, whatever the picks. */
const seamsFor = (pick: number[]): Seams =>
  triangleSeams(
    pick,
    pick.findIndex((source) => source !== 0),
    4,
  );

/** Every answer the stubbed server has given, landed. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const TRIANGLE: [number, number][] = [
  [0, 0],
  [4, 0],
  [0, 4],
];

test('a pick draws nothing unsolved, then the seams solved for it', async () => {
  const { presenter, drawn, asked } = carved();

  presenter.pick(0, 1);
  expect(drawn).toEqual([]);
  await settled();

  expect(asked).toEqual([[[1, 0]]]);
  expect(drawn.at(-1)).toEqual([
    { source: 1, mask: [{ loop: TRIANGLE, taken: true }], feather: 4, shift: [0, 0], gain: 1 },
  ]);
});

test('a solve the picks have moved on from is dropped for the one they want', async () => {
  const { store, presenter, asked } = carved();

  presenter.pick(0, 1);
  presenter.pick(1, 1);
  await settled();

  expect(asked.at(-1)).toEqual([[1, 1]]);
  expect(store.solved.has(store.keyOf([1, 0]))).toBe(false);
  expect(store.solved.has(store.keyOf([1, 1]))).toBe(true);
});

test('seams solved for other picks are not drawn', async () => {
  const { presenter, drawn } = carved();
  presenter.pick(0, 1);
  await settled();

  presenter.undo();

  expect(drawn.at(-1)).toEqual([]);
});

// Opening a tile solves every frame it could take, so a hover across its swatches has its seams.
test('opening a tile solves each of its frames before any is hovered', async () => {
  const { presenter, drawn, asked } = carved();
  presenter.openTile(1);
  await settled();

  expect(asked).toEqual([[[0, 1]]]);
  presenter.hoverSwatch(1);
  expect(drawn.at(-1)).toEqual([
    { source: 1, mask: [{ loop: TRIANGLE, taken: true }], feather: 4, shift: [0, 0], gain: 1 },
  ]);
  expect(asked).toHaveLength(1);
});

// Only grown pieces are ever drawn: a swatch hovered before its seams are in leaves the picture be.
test('a hovered swatch not yet solved leaves the page picks seams drawn as they are', async () => {
  const { presenter, drawn } = carved();
  presenter.pick(0, 1);
  await settled();
  const before = drawn.at(-1);

  compositesApi.solveSeams = () => new Promise(() => undefined);
  presenter.openTile(1);
  presenter.hoverSwatch(1);

  expect(drawn.at(-1)).toEqual(before!);
});

test('a seed solves every frame it could take, and each swatch shows that frame grown', async () => {
  const { store, presenter, asked } = carved();
  presenter.seed({ x: 250, y: 250 });
  await settled();

  expect(asked).toEqual([[[0, 0, 1]]]);
  expect(store.outlineFor(1)).toEqual(TRIANGLE);
  // The base grows it nowhere, so its swatch borrows the largest growth another frame found.
  expect(store.outlineFor(0)).toEqual(TRIANGLE);
  expect(store.grownOpen).toEqual(TRIANGLE);
});

test('a seed nothing is solved for yet shows its square in the swatches', () => {
  const { store, presenter } = carved();
  compositesApi.solveSeams = () => new Promise(() => undefined);
  presenter.seed({ x: 250, y: 250 });
  expect(store.outlineFor(1)).toEqual([
    [245, 245],
    [255, 245],
    [255, 255],
    [245, 255],
  ]);
});

// The render gives a pixel to the last piece over it, the base's own pieces included, so a piece of
// the base inside one of another frame is cut back out of that frame's layer.
test('a base piece solved inside another frames piece is cut out of that layer', async () => {
  const { presenter, drawn } = carved();
  const inner: [number, number][] = [
    [1, 1],
    [2, 1],
    [1, 2],
  ];
  compositesApi.solveSeams = (_recipe, picks) =>
    Promise.resolve({
      seams: picks.map((pick) => ({
        ...seamsFor(pick),
        vertices: [...TRIANGLE, ...inner],
        tiles: [
          [0, 1, 2],
          [3, 4, 5],
        ],
        source: [1, 0],
        zone: [0, 0],
        corridor: [0.01, 0.01],
        warp: [
          [1, 0, 0, 1, 0, 0],
          [1, 0, 0, 1, 0, 0],
        ],
        exposure: [1, 1],
      })),
    });
  presenter.pick(0, 1);
  await settled();

  expect(drawn.at(-1)).toEqual([
    {
      source: 1,
      mask: [
        { loop: TRIANGLE, taken: true },
        { loop: inner, taken: false },
      ],
      feather: 4,
      shift: [0, 0],
      gain: 1,
    },
  ]);
});

// A piece read from where its content went is drawn from there: one layer per frame and shift, in
// the layer's pixels, and each covering the other where it lies over it.
test('pieces of one frame read from different places are layers of their own, each shifted', async () => {
  const { store, presenter, drawn } = carved();
  runInAction(() => (store.layerSize = { width: 500, height: 500 }));
  const other: [number, number][] = [
    [10, 10],
    [12, 10],
    [10, 12],
  ];
  compositesApi.solveSeams = (_recipe, picks) =>
    Promise.resolve({
      seams: picks.map((pick) => ({
        ...seamsFor(pick),
        vertices: [...TRIANGLE, ...other],
        tiles: [
          [0, 1, 2],
          [3, 4, 5],
        ],
        source: [1, 1],
        zone: [0, 1],
        corridor: [0.01, 0.01],
        warp: [
          [1, 0, 0, 1, 40, -20] as [number, number, number, number, number, number],
          [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
        ],
        exposure: [1, 1],
      })),
    });
  presenter.pick(0, 1);
  await settled();

  const half = (loop: [number, number][]): [number, number][] => loop.map(([x, y]) => [x / 2, y / 2]);
  expect(drawn.at(-1)).toEqual([
    {
      source: 1,
      mask: [
        { loop: half(TRIANGLE), taken: true },
        { loop: half(other), taken: false },
      ],
      feather: 4,
      shift: [20, -10],
      gain: 1,
    },
    { source: 1, mask: [{ loop: half(other), taken: true }], feather: 4, shift: [0, 0], gain: 1 },
  ]);
});

// A feather is balanced over only once let go of, and the picture keeps the last balance until then.
test('letting go of the feather asks for the page seams balanced over it', async () => {
  const { store, presenter, drawn } = carved();
  const feathers: (number | undefined)[] = [];
  compositesApi.solveSeams = (recipe, picks) => {
    feathers.push(recipe.feather);
    const exposure = [recipe.feather === 0.01 ? 0.5 : 1];
    return Promise.resolve({ seams: picks.map((pick) => ({ ...seamsFor(pick), exposure })) });
  };
  presenter.pick(0, 1);
  await settled();

  presenter.setFeather(0.01);
  await settled();
  expect(feathers).toEqual([DEFAULT_FEATHER]);

  compositesApi.solveSeams = (recipe) => {
    feathers.push(recipe.feather);
    return new Promise(() => undefined);
  };
  presenter.settleFeather(0.01);
  expect(feathers).toEqual([DEFAULT_FEATHER, 0.01]);
  expect(drawn.at(-1)?.map((layer) => layer.gain)).toEqual([1]);
  expect(store.drawnSeams?.seams.pick).toEqual([1, 0]);
  expect(loadMergeSession('')?.feather).toBe(0.01);
});

test('a piece is drawn under the balance the solve measured across its seams', async () => {
  const { presenter, drawn } = carved();
  compositesApi.solveSeams = (_recipe, picks) =>
    Promise.resolve({ seams: picks.map((pick) => ({ ...seamsFor(pick), exposure: [0.75] })) });
  presenter.pick(0, 1);
  await settled();

  expect(drawn.at(-1)?.map((layer) => layer.gain)).toEqual([0.75]);
});

test('every tile back on the base needs no solve and draws nothing over it', async () => {
  const { presenter, drawn, asked } = carved();
  presenter.pick(0, 1);
  await settled();

  presenter.pick(0, 0);
  await settled();

  expect(asked).toHaveLength(1);
  expect(drawn.at(-1)).toEqual([]);
});

test('a reaped volume draws the tiles as they are and stops asking', async () => {
  const { store, presenter, asked, drawn } = carved();
  compositesApi.solveSeams = (_recipe, picks) => {
    asked.push(picks);
    return Promise.resolve({ seams: null });
  };

  presenter.pick(0, 1);
  await settled();
  presenter.pick(1, 1);
  await settled();

  expect(asked).toHaveLength(1);
  expect(store.unseamed).toBe(true);
  expect(drawn.at(-1)?.[0]?.mask).toHaveLength(2);
});

test('a request that fails says so, and is asked again once the page wants something else', async () => {
  const { presenter, asked, toasts } = carved();
  compositesApi.solveSeams = (_recipe, picks) => {
    asked.push(picks);
    return Promise.reject(new Error('the worker went away'));
  };

  presenter.pick(0, 1);
  await settled();
  expect(asked).toHaveLength(1);
  expect(toasts.toasts.map(({ message }) => message)).toEqual([MergePresenterStrings.couldNotFindSeams()]);

  presenter.hoverTile(0);
  presenter.redraw();
  await settled();
  expect(asked).toHaveLength(1);
  presenter.openTile(0);
  await settled();
  expect(asked).toEqual([[[1, 0]], [[1, 0]]]);
});

test('a pick set the server refuses is not asked for again', async () => {
  const { presenter, asked } = carved();
  compositesApi.solveSeams = (_recipe, picks) => {
    asked.push(picks);
    return Promise.resolve({ seams: picks.map(() => null) });
  };

  presenter.pick(0, 1);
  await settled();
  presenter.redraw();
  await settled();

  expect(asked).toHaveLength(1);
});

// A tile's frames are one request, and one of them refused leaves the others' seams in hand.
test('a set refused inside a request is not asked for again, and the rest are kept', async () => {
  const { store, presenter, asked } = carved();
  const refused = [0, 0, 1];
  compositesApi.solveSeams = (_recipe, picks) => {
    asked.push(picks);
    return Promise.resolve({
      seams: picks.map((pick) => (pick.join() === refused.join() ? null : seamsFor(pick))),
    });
  };
  runInAction(() => {
    store.recipe = { ...store.recipe!, sources: [...store.recipe!.sources, store.recipe!.sources[0]!] };
  });

  presenter.seed({ x: 250, y: 250 });
  await settled();
  presenter.redraw();
  await settled();

  expect(asked).toEqual([
    [
      [0, 0, 1],
      [0, 0, 2],
    ],
  ]);
  expect(store.unsolvable.has(store.keyOf(refused))).toBe(true);
  expect(store.solved.has(store.keyOf([0, 0, 2]))).toBe(true);
  expect(store.searching).toBe(false);
});

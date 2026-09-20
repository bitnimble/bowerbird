import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import type { AssemblyRecipe } from '../../../../../../src/schemas/assembly';
import { compositesApi } from '../../../../api/composites';
import { MemoryStorage } from '../../../../test_storage';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { MergePresenter } from '../merge_presenter';
import { loadMergeSession, saveMergeSession } from '../merge_storage';
import { MergeStore } from '../merge_store';
import { assemblyRecipeFixture, FIXTURE_SEEDS, NO_COMPOSITOR, triangleSeams } from './fixtures/assembly_recipe';

const solving = compositesApi.solveSeams;
const live: MergePresenter[] = [];

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});

afterEach(() => {
  compositesApi.solveSeams = solving;
  for (const presenter of live.splice(0)) presenter.finish();
});

/** A presenter over a carve that left its seam volume, recording every solve it asks for. */
function build(): { store: MergeStore; presenter: MergePresenter; asked: AssemblyRecipe[] } {
  const store = new MergeStore();
  runInAction(() => {
    const recipe = { ...assemblyRecipeFixture(), seamVolume: 'key' };
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    store.status = 'ready';
  });
  const asked: AssemblyRecipe[] = [];
  compositesApi.solveSeams = (recipe, picks) => {
    asked.push(recipe);
    return Promise.resolve({ seams: picks.map((pick) => triangleSeams(pick, pick.length - 1, 4)) });
  };
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), NO_COMPOSITOR);
  live.push(presenter);
  return { store, presenter, asked };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('a click in removal seeds a tile asking for the ground, and the others keep their subjects', () => {
  const { store, presenter } = build();
  presenter.toggleRemoving();
  presenter.seed({ x: 250, y: 250 });

  expect(store.recipe!.takes).toEqual(['subject', 'subject', 'ground']);
});

// A merge that never removes anything stores the recipe it always did.
test('a click out of removal asks for the subject again, and states nothing', () => {
  const { store, presenter } = build();
  presenter.toggleRemoving();
  presenter.toggleRemoving();
  presenter.seed({ x: 250, y: 250 });

  expect(store.recipe!.takes).toBeUndefined();
});

test('what a tile asks for reaches the server with the picks', async () => {
  const { presenter, asked } = build();
  presenter.toggleRemoving();
  presenter.seed({ x: 250, y: 250 });
  presenter.pick(2, 1);
  await settled();

  expect(asked.at(-1)?.takes).toEqual(['subject', 'subject', 'ground']);
});

// The same tile, the same frame: only what it asks for differs, and a solve for one is no answer
// for the other.
test('a tile asking for the ground is solved apart from the same tile asking for its subject', () => {
  const { store, presenter } = build();
  presenter.seed({ x: 250, y: 250 });
  const subject = store.keyOf([0, 0, 1]);
  presenter.openTile(null);

  presenter.toggleRemoving();
  presenter.seed({ x: 250, y: 250 });

  expect(store.keyOf([0, 0, 1])).not.toBe(subject);
});

test('a seed closed with nothing picked takes what it asked for with it', () => {
  const { store, presenter } = build();
  const before = store.recipe;
  presenter.toggleRemoving();
  presenter.seed({ x: 250, y: 250 });
  presenter.openTile(null);

  expect(store.recipe).toEqual(before!);
});

test('what each seed asks for is kept across a reload', () => {
  const { presenter } = build();
  presenter.toggleRemoving();
  presenter.seed({ x: 250, y: 250 });
  presenter.pick(2, 1);

  expect(loadMergeSession('')?.takes).toEqual(['subject', 'subject', 'ground']);
});

test('a session saved before a seed could ask for anything restores every seed as a subject', () => {
  saveMergeSession('job', { picks: [0, 1], base: 0, seeds: FIXTURE_SEEDS });
  expect(loadMergeSession('job')?.takes).toBeUndefined();
});

test('a session whose takes do not match its seeds is discarded rather than half-restored', () => {
  sessionStorage.setItem(
    'bowerbird.merge.job',
    JSON.stringify({ picks: [0, 1], base: 0, seeds: FIXTURE_SEEDS, takes: ['ground'] }),
  );
  expect(loadMergeSession('job')).toBeNull();
});
